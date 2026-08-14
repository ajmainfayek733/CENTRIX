# Agent.Host

The interactive half of the agent, running in the logged-on user's session as a standard user.
Everything it does is session-bound: the foreground window, idle time, input counts and the screen
itself are all invisible from session 0, where the service lives.

It holds **no credentials** and writes **nothing durable** except screenshot JPEGs into the shared
spool directory. Observations go to the service over the named pipe; the service owns storage and
upload.

**Output:** `EmployeeMonitor.Host.exe` (WPF + Windows Forms, self-contained, single-file,
untrimmed)
**Dependencies:** `Microsoft.Extensions.Hosting`, `Agent.Core`. Screenshot capture uses
`System.Drawing`, which ships in the Windows Desktop SDK - no package needed.

Two project settings matter:

- **`ApplicationHighDpiMode = PerMonitorV2`.** Without per-monitor awareness Windows virtualizes
  the screen size and `CopyFromScreen` returns a stretched, blurry image. Set as a project property
  rather than in the manifest because Windows Forms configures DPI mode itself and rejects the
  manifest form (WFO0003).
- **`app.manifest` requests `asInvoker`**, deliberately. The service launches this process with the
  logged-on user's own token, and on a managed workstation that user is a standard user;
  `requireAdministrator` would make the launch fail for exactly the people being monitored.
  Everything needing elevation lives in the service. The manifest also declares Windows 10/11
  support, without which `Environment.OSVersion` reports 6.2 and every device would report the
  wrong version to the dashboard.

---

## `App` - `App.xaml` / `App.xaml.cs`

The application shell. `App.xaml` merges two resource dictionaries in a fixed order: **slot 0** is
the palette (replaced wholesale by `ThemeManager` at runtime) and **slot 1** is `Controls.xaml`
(never swapped). `ThemeManager` indexes slot 0 directly, so the order is load-bearing.

### `OnStartup`

1. **Single-instance guard.** A `Local\EmployeeMonitor.Host` mutex. Scope is `Local\`, not
   `Global\`: one host per interactive session is correct, and a global mutex would wrongly block a
   second user during fast user switching. A second instance shuts down immediately. Without this,
   a race between the supervisor's process check and its launch could start two hosts and
   double-count every keystroke.
2. `ThemeManager.Apply(AppTheme.System)`.
3. `BuildHost()` and resolve `HostIpcClient`, `TrayIconService`, `AlertEngine`.
4. Wire notifications: both `AlertEngine.NotificationRequested` and
   `HostIpcClient.NotificationRequested` are marshalled onto the dispatcher and shown by the tray.
5. `TrayIconService.Initialize()` and `OpenRequested` -> `ShowMainWindow`.
6. **`InputCounter.Start()` on this thread.** Low-level hooks must be installed from a thread with
   a message pump; installing them from a background worker yields hooks that never fire.
7. Start the reconnect loop and the generic host.
8. Hook `DispatcherUnhandledException`.

### `BuildHost`

`Host.CreateApplicationBuilder()` with:

- Event Log logging (`EmployeeMonitorHost` source).
- The rolling file sink with prefix **`host-s{SessionId}`** - per terminal-services session, not
  per process. Fast user switching runs one host per logged-on user simultaneously, and they must
  not append to the same handle; the single-instance mutex guarantees at most one writer per
  session id.
- Singletons: `HostIpcClient`, `ForegroundWindowTracker`, `BrowserUrlExtractor`, `InputCounter`,
  `ScreenshotCapturer`, `SessionEventMonitor`, `AlertEngine`, `TrayIconService`.
- Hosted service: `MonitoringOrchestrator`.

### Other members

| Member | Description |
|---|---|
| `ConnectLoopAsync(ct)` | Retries `HostIpcClient.ConnectAsync` every 10 s while disconnected. The host is usually started by the service but can outlive a service restart, so reconnection is continuous rather than a one-shot attempt at startup. |
| `ShowMainWindow()` | Lazily constructs `MainWindow` and shows it. |
| `OnDispatcherUnhandledException` | Logs and sets `Handled = true`. A crash in the UI thread must not take monitoring down - the window is a disclosure surface, and collection runs on background workers that are unaffected. |
| `OnExit` | Cancels the reconnect loop, allows the window to really close, disposes the tray, disposes `InputCounter` (unhooks), `SessionEventMonitor` (unsubscribes) and `BrowserUrlExtractor` (completes the reader queue), stops the host with a **5 s bound** so a wedged worker cannot hang logoff, then disposes the IPC client and mutex. |

**`AssemblyInfo.cs`** carries only the standard WPF `[assembly: ThemeInfo(...)]`.

---

## `Ipc/HostIpcClient.cs`

The host's connection to the service. Everything the host observes is sent here; nothing is
written to disk or uploaded from this process.

If the pipe is down, submissions are **dropped rather than buffered**. The service owns the durable
queue, and duplicating it here would mean two stores that can disagree. A dropped submission costs
at most one polling interval of data, because the SCM restarts the service far faster than a
session lasts.

| Member | Description |
|---|---|
| `IsConnected` | Whether the pipe is live. |
| `Policy` | Latest policy pushed by the service. Starts at the Features.md defaults. |
| `PolicyUpdated` | `event Action<AgentPolicy, bool>` - policy and whether consent is required. |
| `NotificationRequested` | `event Action<ShowNotificationMessage>` |
| `ScreenshotRequested` | `event Action` - on-demand capture requested by the service. |
| `ConnectionStateChanged` | `event Action<bool>` |
| `ConnectAsync(ct)` | Connects with `TokenImpersonationLevel.None` - stated explicitly, though it is also the default, because a named pipe server can call `ImpersonateNamedPipeClient` and execute as whoever connected. This client runs as the employee and connects to a well-known name, so a process that owned that name first could impersonate them; `None` is the documented defence, and writing it here stops a later edit granting impersonation by choosing a different overload. Connects with a **3 s** timeout (the caller retries on a schedule, and a long block would delay collectors starting when the service simply is not up yet), sends `HelloMessage` carrying the user SID, name, terminal-services session id and host version, then starts the read loop. Returns `false` on `TimeoutException`, `IOException` or `UnauthorizedAccessException`. |
| `ReadLoopAsync(ct)` (private) | Dispatches `HelloAckMessage` and `PolicyUpdatedMessage` to `Policy` + `PolicyUpdated`, `ShowNotificationMessage` to `NotificationRequested`, `RequestScreenshotMessage` to `ScreenshotRequested`, and `ShutdownMessage` to `Environment.Exit(0)`. Always raises `ConnectionStateChanged(false)` on exit. |
| `SendAsync(message, ct)` | Serialized behind a `SemaphoreSlim`, because collectors run on several timers and two concurrent writes would interleave their length-prefixed frames. Returns `false` when not connected or on `IOException`/`ObjectDisposedException`. |
| `DisposeAsync()` | Cancels the reader, disposes the pipe and the write lock. |

`WindowsSessionId` is `Process.GetCurrentProcess().SessionId` - the same id the host's log file is
named after. The service logs it to tell concurrent hosts apart during fast user switching, which
a process id could not do.

---

## Collectors

### `Collectors/ForegroundWindowTracker.cs`

Reads the foreground application: app name, process name, executable path and window title.

**`ForegroundSnapshot`** (sealed record): `AppName?`, `ProcessName?`, `ExecutablePath?`,
`WindowTitle`, `WindowHandle`, `IsBrowser`.

- **`IsSameActivityAs(other)`** - two snapshots are the same activity session when the process
  **and** the window title both match. Title is included because a browser or editor staying
  focused while the user moves between tabs or files is genuinely different activity.

**`ForegroundWindowTracker`**

| Member | Description |
|---|---|
| `KnownBrowsers` (private static) | `chrome`, `msedge`, `firefox`, `brave`, `opera`, `vivaldi` -> `BrowserKind`, matched case-insensitively on the extensionless process name. |
| `ClassifyBrowser(processName)` (static) | Maps to a `BrowserKind`, or `Other`. |
| `Capture()` | Returns a snapshot, or `null`. `null` means the desktop has focus **or the secure desktop is up** (UAC prompt, Ctrl+Alt+Del) - either way there is no application to attribute time to. |
| `ResolveProcess(pid)` (private) | Resolves the executable path and the process start time through `NativeMethods.QueryProcessIdentity`. A process that refuses a handle (protected processes, or one that exited between the window read and this call) yields **no identity at all** rather than a cached one - reporting "unknown" beats reporting the wrong application. |
| `ResolveDescription(path)` (private) | The `FileDescription` from the version resource, cached **by path**. Reading a version resource touches the disk, and keyed by path it happens once per application for the session rather than once per process instance - Chrome would otherwise pay it for every renderer that reaches the foreground. |

**This runs on every tick, so its cost is the agent's steady-state CPU floor.** Three things keep
it near zero:

| Layer | Effect |
|---|---|
| Per-tick memo (`_lastWindow` + `_lastPid`) | Staying in one window - what a working day mostly consists of - costs four Win32 calls and nothing else. Only the title is re-read, because that is the one thing that changes while a window stays focused. A process would have to exit *and* a new one both inherit its id and adopt its window handle within one tick for this to be wrong. |
| `_processCache` keyed by pid, **validated against the process start time** | Keying on the id alone is not safe: Windows reuses process ids, so an entry left by an exited process would silently attribute the new owner's foreground time to the old application - a wrong answer that looks entirely plausible in a report. The start time turns that into a cheap miss. At `ProcessCacheLimit` (256) the whole cache is cleared rather than evicting LRU, which is adequate because every entry is re-validated on use anyway. |
| `QueryFullProcessImageName` instead of `Process.MainModule` | `MainModule` **enumerates every loaded module** of the target process to return the first one - for a browser, hundreds of DLLs of work for a value the kernel already holds. It also fails outright across integrity levels, which is why elevated applications previously logged with no path at all. |

### `Collectors/InputCounter.cs`

Keystroke and mouse-click counts as an activity score. `IDisposable`.

> **This is the single most privacy-critical file in the codebase.** The class counts events and
> never inspects them. The keyboard callback increments a counter and returns; it does not read
> `lParam`, does not decode the virtual key code, and has no field, buffer or log statement capable
> of holding a typed character. The only way to guarantee passwords and private messages are never
> captured is for the data never to be read in the first place.
>
> **Do not add key-code handling here.** If a future feature seems to need it, it does not.

| Member | Description |
|---|---|
| `_keyboardProc` / `_mouseProc` | The delegates are stored in **fields** because `SetWindowsHookEx` does not root its callback. As locals the GC would collect them while Windows still held the pointer, and the process would crash the first time a key was pressed. |
| `Start()` | Installs `WH_KEYBOARD_LL` and `WH_MOUSE_LL`. Must be called from a thread with a running message pump - low-level hooks are dispatched to the installing thread's message queue, and installing them from a worker yields a hook that silently never fires. Logs an error and returns if installation fails; metrics then read zero. |

> **A low-level hook can be removed behind your back.** The procedure must complete within
> `LowLevelHooksTimeout` (`HKCU\Control Panel\Desktop`, capped at 1000 ms since Windows 10 1709).
> On Windows 7 and later a hook that exceeds it is *silently removed without being called*, and
> Microsoft states there is **no way for the application to know**. Metrics would read zero for the
> rest of the session with nothing in any log.
>
> The callbacks are two instructions and a chain call, so they cannot time out themselves. The
> exposure is the **installing thread**: these hooks dispatch to the message queue of the thread
> that installed them, which here is the UI thread. Nothing slow may ever be added to the
> disclosure window's handlers. Installing from a dedicated thread with its own message loop would
> remove the coupling and is the correct fix if this ever bites.
| `KeyboardCallback` (private) | Increments on `WM_KEYDOWN`/`WM_SYSKEYDOWN` when `nCode >= 0`, then always chains `CallNextHookEx`. |
| `MouseCallback` (private) | Increments per button on `WM_LBUTTONDOWN`/`RBUTTONDOWN`/`MBUTTONDOWN`/`XBUTTONDOWN`. **Mouse movement is deliberately not counted** - it fires hundreds of times a second and says little about engagement that clicks do not. |
| `InputSample` (readonly record struct) | `KeyCount`, `MouseLeft`, `MouseRight`, `MouseMiddle`, `MouseOther`, plus `MouseTotal` and `IsEmpty`. |
| `DrainSample()` | Reads **and zeroes** every counter via `Interlocked.Exchange`, so input arriving during the read is attributed to the next window rather than lost between the two. |
| `Dispose()` | Unhooks both hooks. |

All counters are written from Windows-owned hook threads and read by the sampler, so every access
goes through `Interlocked`.

### `Collectors/BrowserUrlExtractor.cs`

Reads the address bar of the focused browser window through **UI Automation**.

UIA rather than reading browser history files or installing an extension: history files are locked
while the browser runs and lag behind by design, and an extension would need per-browser packaging
and could be removed by the user. UIA sees what is actually on screen right now.

**This is the most expensive thing the agent does.** Every UIA call is a blocking cross-process
request into the browser, and a full descendant search of a browser window can visit thousands of
elements. Three mechanisms bound it:

| Mechanism | Effect |
|---|---|
| **One reader thread for the whole process** | A browser that stops answering blocks that one thread and nothing else. Further requests are refused outright (`_readInFlight`) rather than queued, so a wedged browser cannot accumulate work or grow a thread per tick. |
| **The address bar element is cached per window** (`_addressBars`) | Chromium and Firefox keep one omnibox element for the life of a window, across every navigation and tab switch in it. After the first search, reading the current URL is a single property fetch instead of a tree walk. |
| **The search runs under a `CacheRequest`** | Each candidate's name and value arrive in the same round trip that found it. Reading them through `Current` would turn one cross-process call into three per element. |

The **caller** decides *when* to ask - see `ShouldProbeBrowser` in the orchestrator. This class only
guarantees that asking is as cheap as it can be and can never stall the monitoring loop.

**`BrowserVisit`** (sealed record): `Browser`, `RawUrl`, `Domain`, `Protocol`, `PageTitle?`,
`ProfileName?`.

| Member | Description |
|---|---|
| `TryExtractAsync(snapshot, timeoutMs, maxRetryAttempts, ct)` | Returns a visit or `null`. **Never throws and never blocks longer than `timeoutMs`.** A timeout leaves the reader working in the background; the next call is refused until it finishes, which is the intended back-pressure. Cancellation is not counted as a browser failure - it means shutdown. |
| `_readInFlight` | The one-slot admission gate. Also the memory barrier that lets the caller and the reader share `_addressBars` without a lock: the caller only reads the cache while holding the slot, which is exactly when the reader is idle. |
| `_probeState` / `FailureCooldown` (5 min) | Consecutive failures per process name. Chromium windows still painting return nothing for the first probe or two - that is a retry. A browser that never yields a URL at all (an unsupported fork, a hardened build, an address bar hidden by policy) is a different case: once the attempt budget is spent it is left alone for the cooldown and then given another chance, so the suppression **heals itself** if the cause was temporary. A URL that will not parse clears the count rather than counting against it - the address bar answered. |
| `RunReader()` (private) | The MTA reader loop. An STA reader would have to pump messages to avoid deadlocking against the browser's own UI thread. If it ever exits, `_readerStopped` degrades extraction to "no URL" permanently and logs an error rather than hanging callers. |
| `ReadUrl(request)` (private) | Cached element first; falls back to a search when there is no entry or the cached element has gone (`ElementNotAvailableException`, `COMException`). |
| `FindAddressBar(windowHandle)` (private static) | Finds descendant `Edit` controls with a `ValuePattern`. Prefers one whose name contains `Address`, `Search with` or `Search or enter` (Chromium marks the omnibox this way, and a page can contain other edits); otherwise falls back to the first non-empty edit value. Returns the pattern as well as the value, so it can be cached. |
| `TryNormalizeUrl(raw, out uri)` (private static) | Browsers hide the scheme, so `github.com/anthropics` needs `https://` prepended before it will parse. A bare search phrase is rejected by requiring a dot in the authority - this keeps `how do I center a div` out while letting `github.com/anthropics` through. **Only `http` and `https` are accepted**: a `file://` path or `chrome://settings` is local navigation, not web browsing, and logging file paths would capture document names the spec's purpose-limitation rule does not cover. |
| `DerivePageTitle(windowTitle, browser)` (private static) | Strips the per-browser suffix (` - Google Chrome`, ` - Mozilla Firefox`, etc.) so the stored page title is just the page. |
| `Dispose()` | Completes and disposes the request queue. The reader is **not joined** - it may be blocked inside a browser that is not answering, and logoff must not wait for it. It holds nothing that needs releasing and the process is about to exit. |

### `Collectors/ScreenshotCapturer.cs`

Optional, policy-controlled periodic capture.

**`CapturedScreenshot`** (record): `ClientEventId`, `FilePath`, `SizeBytes`, `Width`, `Height`,
`CapturedAt`.

| Member | Description |
|---|---|
| `Capture(jpegQuality)` | Captures `SystemInformation.VirtualScreen` - the bounding box of **every** monitor, so a multi-monitor desk yields one image rather than only the primary display - into a 24-bit bitmap via `Graphics.CopyFromScreen`, saves it to the spool directory as `{clientEventId}.jpg`, and returns the metadata. Returns `null` on zero screen area, and catches all exceptions: a capture can fail legitimately when the secure desktop is up (UAC prompt, lock screen) and `CopyFromScreen` is denied, in which case the interval is skipped rather than crashing. |
| `Save(bitmap, path, quality)` (private static) | Clamps quality to 10-100 and encodes with the JPEG codec. If no JPEG encoder is registered - not a configuration we expect - it falls back to PNG so the feature keeps working rather than silently producing nothing. |

Only the **path** crosses the IPC boundary; the service uploads the bytes.

### `Collectors/SessionEventMonitor.cs`

Watches workstation state changes: lock/unlock, logoff, shutdown, sleep and resume. These are what
let the attendance record close correctly instead of leaving a session open until the next boot,
and what tell the activity log to stop counting an application as "in use" when the screen is
locked. `IDisposable`.

| Member | Description |
|---|---|
| `SessionSuspended` | `event Action<SessionEndReason>` - the desktop became unavailable. |
| `SessionResumed` | `event Action` - the desktop became available again. |
| `IsLocked` | Current lock state, read by the orchestrator. |
| `Start()` | Subscribes to `SessionSwitch`, `PowerModeChanged` and `SessionEnding`. Idempotent. |
| `OnSessionSwitch` | `SessionLock` -> `Lock`; `ConsoleDisconnect`/`RemoteDisconnect` -> `Disconnect` (RDP and fast user switching: the session still exists but nobody is looking at it, so it must not count as active time); `SessionLogoff` -> `Logout`; unlock/connect/logon -> `SessionResumed`. |
| `OnPowerModeChanged` | `Suspend` -> `Sleep`; `Resume` -> `SessionResumed`. |
| `OnSessionEnding` | `SystemShutdown` -> `Shutdown`, otherwise `Logout`. Windows gives a process only a few seconds here before killing it, so handlers must persist the final attendance state and return - anything slower will not complete. |
| `Dispose()` | Unsubscribes. |

### `Interop/NativeMethods.cs`

Internal static partial class. Win32 entry points used by the interactive collectors - all
session-bound, which is why this half of the agent exists as a separate executable.

| Group | Members |
|---|---|
| Foreground window | `GetForegroundWindow`, `GetWindowThreadProcessId`, `GetWindowTextW`, `GetWindowTextLengthW`, and the `GetWindowTitle(hWnd)` helper (allocates `length + 1` for the terminating null, returns empty when there is no title) |
| Idle detection | `LASTINPUTINFO`, `GetLastInputInfo`, and `GetIdleTime()` |
| Hooks | `WH_KEYBOARD_LL`, `WH_MOUSE_LL`, the `WM_*` message constants, `LowLevelHookProc`, `SetWindowsHookExW`, `UnhookWindowsHookEx`, `CallNextHookEx`, `GetModuleHandleW` |

**`GetIdleTime()`** returns the time since the last keyboard or mouse input in the session.

`GetLastInputInfo` reports **only for the session that called it**, which is why idle detection
lives in the per-user host: a service in session 0 would see nothing the employee does.

Two counter hazards, both from the API contract:

- **Wrap.** `GetLastInputInfo` and `GetTickCount` are 32-bit millisecond counters that wrap after
  ~49.7 days of uptime. Subtracting them as **unsigned** handles the wrap, so a long-uptime
  workstation does not suddenly report a 49-day idle time.
- **Skew.** `dwTime` is documented as **not guaranteed to be incremental** - a timing gap between
  the raw input thread and the desktop thread, or a `SendInput` event carrying its own tick count,
  can leave it *ahead* of the tick count we read. The unsigned subtraction then underflows to most
  of the counter range. Untreated, that reports an active user as weeks idle and escalates a
  Critical inactivity alert at them. Anything past half the range (~24.8 days) is treated as skew
  and returns zero.

Sleep needs no special case: `GetTickCount` includes time spent asleep, so a machine resumed after
three hours correctly reports three hours of idleness. What to do with a stretch the agent never
observed is decided separately, in `MonitoringOrchestrator.CloseObservationGapAsync`.

---

## Services

### `Services/MonitoringOrchestrator.cs`

`BackgroundService`. Drives every interactive collector and turns their observations into typed
telemetry events.

**One loop rather than a timer per collector**, because attendance, activity sessions, browser
visits and the idle state all depend on the same "what is happening right now" reading. Sampling
them independently would let them disagree - an activity session recorded as `Application` while
the idle monitor already considers the user away.

#### How time is measured

Every report about an employee is built on this, so the rules are explicit:

| Rule | Why |
|---|---|
| **Durations are wall-clock differences between recorded instants.** Nothing is derived from the tick rate. | A slow or delayed tick changes *when a change is noticed*, never *how much time is reported*. Counting `PollSeconds` per tick - the previous behaviour - assumed each tick took exactly its interval, when the real period is interval + work, so the totals drifted downwards and worst for the busiest machines. |
| **A transition into or out of idle is dated from the last real input**, not from the tick that noticed it. | Otherwise every idle period hands the whole idle threshold - five minutes by default - to whichever application was in focus when the user walked away, and starts the idle period five minutes late. Ten idle periods a day is nearly an hour of phantom working time. |
| **Time the agent did not observe is not invented.** | A laptop closed at lunch and opened at two would otherwise report ninety minutes of the last application in focus. |
| **The attendance totals are accumulated from the closed segments**, not counted separately. | The totals and the activity log can never disagree. Time from a segment too short to earn a row is still counted, so a day of rapid window switching does not report as less than a day. |
| **Durations are rounded, not truncated.** | Truncating every segment biases the day downwards by up to a second per switch - on the order of a minute across a busy day - and always in the same direction. |

**And how it stays cheap:** the poll interval buys boundary precision, not data, so it stays at one
second while the expensive collector - the browser address bar - is probed only when the window it
belongs to looks like it may have navigated. See `ShouldProbeBrowser`.

**State**

| Field | Purpose |
|---|---|
| `_userSid`, `_sessionId`, `_loginTime` | Identify this logon session. `_sessionId` is a fresh GUID per host start and is the foreign key every event carries. |
| `_stateGate` (`SemaphoreSlim`) | Serialises everything touching the open segments and the running totals. **Two threads reach that state**: the monitoring loop, and the Windows session callbacks for lock, sleep and shutdown, which arrive whenever Windows decides to send them. Without it, a suspend landing mid-tick could close a segment the tick is still writing and double-count it. |
| `_current` (`ActivitySegment`) | In-progress foreground activity session: `ActivitySessionId`, `Snapshot`, `Type`, `StartedAt`. |
| `_currentVisit` (`BrowserSegment`) | In-progress browser visit: `BrowserActivityId`, `ActivitySessionId`, `Visit`, `WindowTitle`, `StartedAt`. |
| `_lastTickAt` | The last observed instant, which is what makes a discontinuity detectable. |
| `_lastMetricFlush`, `_lastScreenshot`, `_lastAttendanceFlush` | Interval bookkeeping. |
| `_activeTime`, `_idleTime` (`TimeSpan`) | Observed working and non-working time, accumulated from closed segments. |
| `_observationBroken` (interlocked `int`) | Set by the resume and suspend callbacks to tell the next tick the clock ran on without us. An `int` rather than a timestamp because it is written from a Windows callback thread and an `int` is written atomically where a `DateTimeOffset` is not. |
| `_probedWindow`, `_probedTitle`, `_probedAt`, `_probeAttempts` | Browser probe gating. |
| `MetricFlushInterval` (1 min) | How often the activity metric window is closed and sent. |
| `AttendanceFlushInterval` (2 min) | How often the open attendance row is refreshed - frequent enough that a power loss loses at most this much of the day, cheap enough not to matter since it is an upsert on one row. |
| `GapIntervalMultiple` (4) / `MinimumGapThreshold` (10 s) | When a late tick stops being a busy machine and starts being a discontinuity. Four intervals rather than two because a workstation under load can genuinely stall a one-second loop; the ten-second floor because four intervals of a one-second poll would treat any brief hiccup as a sleep. |

**Lifecycle**

`ExecuteAsync` subscribes to the session events, wires on-demand screenshots, and **opens the
attendance record immediately** (a session that is never opened cannot be closed). It then loops at
`AppSession.PollSeconds` (clamped 1-60 s), catching per-tick exceptions so one bad tick - a window
that vanished mid-read, a UIA hiccup - does not stop monitoring for the rest of the session.

The tick's work is **subtracted from the wait** rather than added to it. Delaying a full interval
after each tick makes the real period interval + work, which drifts further from what an
administrator configured the busier the machine gets.

Cancellation **breaks out of the loop rather than propagating**. An exception escaping the delay
would skip the shutdown path below and lose the end of every session - the exact failure that shows
up later as an attendance row closed as `Recovered`.

`ShutdownAsync` then closes the current segment with `SessionEnd`, flushes the final metric window
(otherwise the last partial minute of keystrokes is lost) and writes the closing attendance row.

**`TickAsync`** - the whole body runs under `_stateGate`.

1. Stamp `_lastTickAt`; if the previous tick was more than the gap threshold ago, or a session
   callback flagged a break, close the observation gap.
2. Read idle time, derive `lastInputAt`, and resolve the current state.
3. On a state or app/title change, resolve the transition instant, close the old segment there and
   start the new one **at the same instant** - so the timeline has no gap and no overlap.
4. If `Application`: track the browser and evaluate application alerts. Otherwise close any open
   browser visit and reset the probe gate.
5. Evaluate idle alerts.
6. Flush metrics and attendance on their intervals; capture a screenshot if due.

| Method | Description |
|---|---|
| `ResolveState(policy, idleTime, idleThreshold)` | Precedence is **lock beats idle**: a locked screen is locked whether or not the idle timer elapsed, and reporting it as `Idle` would lose why the user stopped. Then `!Activity.Enabled` -> `Desktop`; `idleTime >= threshold` -> `Idle`; a captured snapshot -> `Application`; `null` snapshot -> `Desktop`. |
| `ResolveTransitionInstant(now, lastInputAt, next)` | **When the transition happened, as opposed to when the tick noticed it.** An ordinary app switch is within one interval, so `now` is good enough. Crossing the idle boundary is not: the state changed at the last keypress or click, which is the idle threshold ago on the way in and a fraction of a second ago on the way out. Clamped to the open segment's start (an application that took focus while the user was already away would otherwise get a negative duration) and to `now` (which a clock adjustment between the two reads could otherwise exceed). |
| `DetermineEndReason(next)` | Maps the incoming state to an `ActivityEndReason` - `Idle` -> `UserInactivity`, `Locked` -> `ScreenLock`, `Sleeping` -> `Sleep`, `Disconnected` -> `Disconnect`, otherwise `AppSwitch`. |
| `CloseObservationGapAsync(lastObservedAt, now, ct)` | Ends the open segment at the last instant actually observed and **leaves the gap attributed to nobody**. Also resets the browser probe (nothing on screen can be trusted to be what was there before) and drains the input counters, because a metric window spanning the gap would report a minute of keystrokes as if they happened in one window. |
| `CloseCurrentSegmentAsync(reason, endedAt, ct)` | Closes any browser visit at the same instant (a visit cannot outlive the session containing it), **counts the time before the length test** and then **discards sub-second segments** - noise from rapid alt-tabbing that would flood the store - before tagging via `PolicyEvaluator.MatchApplication` and submitting `SubmitActivitySessionMessage`. |
| `Accumulate(type, duration)` | `Application`/`Desktop` is working time, everything else is away time. One clock split in two; nothing is counted twice. |
| `TrackBrowserAsync(policy, snapshot, now, ct)` | Closes the visit and resets the probe gate if browser monitoring is off or the app is not a browser. Otherwise probes **if `ShouldProbeBrowser` says so**; an unchanged `RawUrl` is the same visit, a changed one closes the old segment and opens a new one linked to the containing activity session, then evaluates domain alerts. |
| `ShouldProbeBrowser(policy, snapshot, now)` | **The single decision separating a UIA search every second from one per navigation.** A browser cannot navigate without changing its window title - the title *is* the page title - so a changed title or a different window triggers an immediate read. A miss is retried on the next tick within `MaxRetryAttempts`, because a window that has just changed often answers a tick or two later while it is still painting. Otherwise it waits for `BrowserMonitor.UrlRefreshSeconds`, which exists only to catch navigation between two pages that share a title. |
| `ResetBrowserProbe()` | Forgets what was last probed. Leaving a browser and returning to the same window and title is otherwise indistinguishable from never having left it, and the visit would not reopen until the refresh interval elapsed. |
| `CloseBrowserVisitAsync(endedAt, ct)` | Same rounding and sub-second rules, tags via `PolicyEvaluator.MatchDomain`, submits `SubmitBrowserActivityMessage`. A `Guid.Empty` activity-session link is normalized to `null`. |
| `FlushMetricsAsync(now, ct)` | Drains the input counters and submits the window. **A window with no input at all is skipped** - the idle activity session already records that the user was away. |
| `FlushAttendanceAsync(logoutTime, reason, now, ct)` | Writes the attendance row. The **open segment counts towards the totals without being closed**, so a refresh mid-way through a two-hour stretch of work reports that work rather than waiting for the user to switch applications. `WorkDate` is the **local** date, because attendance is reported against the employee's own working day. |
| `MaybeCaptureScreenshotAsync(policy, type, now, ct)` | Captures on schedule, but **only while someone is there to be captured**. A locked or idle machine shows a lock screen or an untouched desktop: the capture costs a full-screen bitmap and a JPEG encode, and stores an image answering no question the activity log has not already answered. The timer is deliberately **not** reset while skipping, so the first capture after the user returns happens immediately. |
| `CaptureScreenshotAsync(ct)` | Captures off the UI thread and submits the path and metadata. Guarded by `_screenshotGate` with a zero timeout: a manual request from the dashboard landing during a scheduled capture is skipped, because the image already being taken is the one that was asked for. |
| `OnSessionSuspended(reason)` | **Fire-and-forget** on purpose: this runs on a `SystemEvents` callback Windows expects to return promptly - on shutdown it has only seconds before the process is killed. Takes `_stateGate` with a **3-second bound** (waiting without a limit inside a shutdown callback risks the process being killed mid-wait, which costs the whole session's logout time rather than one segment's end reason), closes the segment, flushes the final attendance row, and flags the observation as broken. |
| `OnSessionResumed()` | Flags the observation as broken. **Only a flag is set here** - this is a Windows callback thread, and the tick owns every timestamp in the class. |
| `Dispose()` | Unsubscribes from the session events and disposes both gates. |

### `Services/AlertEngine.cs`

Desktop notifications for prolonged idle time and blacklist hits.

The escalating idle alert **reuses one client event id** across all three levels, so the dashboard
shows a single incident that grew. Blacklist hits get a fresh id each time, because each is a
distinct access.

| Member | Description |
|---|---|
| `EvaluateIdleAsync(policy, idleTime, userSid, ct)` | Maps idle seconds to a level: `>= SevereSeconds` -> 3/`Critical`, `>= ModerateSeconds` -> 2/`High`, `>= NormalSeconds` -> 1/`Warning`, else 0. **Level 0 resolves** any open incident with an `AlertState.Resolved` event so the dashboard stops showing it open. Otherwise it re-notifies only when the severity actually escalates **or** the renotify interval has elapsed - without that, a user away at lunch would get a popup every polling tick. |
| `EvaluateApplicationAsync(policy, snapshot, userSid, ct)` | Raises a `High`-severity `BlacklistedApp` alert when `PolicyEvaluator.MatchApplication` returns a blacklisted rule, keyed `app:{processName}` for suppression. |
| `EvaluateDomainAsync(policy, visit, userSid, ct)` | Same for `BlacklistedWebsite`, keyed `domain:{domain}`, carrying `ContextDomain` and `ContextUrl`. |
| `ShouldAlert(key)` (private) | Suppresses repeats within a **10-minute** window; without it, staying on a blacklisted site would raise a notification on every poll tick. Prunes expired entries once the table exceeds 200 keys, so it cannot grow across a long session. |
| `SubmitAsync(alert, ct)` (private) | Sends over IPC; warns if the service is not connected. |
| `NotifyDesktop(policy, title, message, severity)` (private) | Raises `NotificationRequested` - but **suppressed outside working hours** unless `Alert.NotifyOutsideWorkingHours` is set. A popup at 11pm is monitoring intruding on personal time. |
| `NotificationRequested` | `event Action<ShowNotificationMessage>`, wired to the tray by the application shell. |

Both blacklist evaluators are no-ops when `Alert.Enabled` or `Alert.BlacklistEnabled` is false;
idle evaluation additionally checks `Alert.Idle.Enabled`.

### `Services/TrayIconService.cs`

The tray icon and its balloon notifications - the visible indicator that monitoring is running.
`IDisposable`.

Windows Forms `NotifyIcon` rather than a WPF equivalent because **WPF has no tray API at all**;
every WPF tray library wraps this same control.

| Member | Description |
|---|---|
| `OpenRequested` | `event Action` - raised by the context menu item and by double-click. |
| `Initialize()` | Builds the context menu and shows the icon with tooltip `Employee Monitor - monitoring is active`. |
| `ShowNotification(notification)` | Maps severity to a `ToolTipIcon` and shows a balloon. The timeout argument has been ignored by Windows since Vista - the shell decides how long a balloon stays up - and is passed for API compatibility only. |
| `BuildIcon()` (private static) | Draws a green ring with a filled centre at 32x32 rather than shipping a `.ico`, which keeps the single-file publish free of an embedded resource for what is a filled circle. `Icon.FromHandle` does not own the GDI handle, so the icon is cloned and the original handle destroyed via `NativeIcon.DestroyIcon` - otherwise every construction leaks one. |
| `Dispose()` | Hides and disposes the icon. |

> **There is deliberately no "Exit" item.** The service restarts the host within seconds, so
> offering an exit that silently undoes itself would be misleading. Task Manager still works - the
> agent is not hiding, it is just not offering a self-defeating button.

**`NativeIcon`** (internal static partial) holds the single `DestroyIcon` import.

---

## UI

### `Views/MainWindow.xaml` / `.xaml.cs`

The employee-facing disclosure window. It exists so the employee can see, at any time, that
monitoring is running and exactly what it does and does not collect, and it captures the
acknowledgement that makes monitoring legitimate. It is deliberately plain - a disclosure surface,
not a dashboard.

| Member | Description |
|---|---|
| `MainWindow(HostIpcClient)` | Fills in version, user name and theme label, subscribes to `PolicyUpdated` and `ConnectionStateChanged`, and renders the current policy and connection state. |
| `SetConnectionState(connected)` | Switches the status text between "connected to the company server" and "storing locally until the server is reachable", and re-colours the status dot from `AccentBrush` / `WarningBrush`. |
| `RenderPolicy(policy, consentRequired)` | Builds the **"what is collected"** list from the policy actually in force, so the window reflects what is really running rather than a hard-coded description that could drift from it. The **"what is not collected"** list is fixed, because those are architectural guarantees rather than policy settings and must read the same regardless of configuration. Shows the consent card when required - and **shows the window itself** if it is not already visible, the one case where the window opens uninvited. |
| `OnAcknowledge` | Sends `ConsentAcknowledgedMessage` for the current policy version and hides the card. |
| `OnRemindLater` | Hides the prompt **for this session only**. Monitoring continues either way - this is not a consent opt-out, and the prompt returns on the next sign-in until acknowledged. |
| `OnToggleTheme` | Cycles the theme and re-resolves the status brush, which was resolved from the old dictionary. |
| `ShowWindow()` | Shows, restores and activates. |
| `OnClosing` | Closing **hides to the tray** rather than exiting, unless `AllowClose()` was called. The agent must keep running - but it must also stay visible and killable, which is why the tray icon is never hidden. |
| `AllowClose()` | Called by the application shell during a real shutdown. |

### `Themes/ThemeManager.cs`

Static class swapping the palette dictionary at runtime.

**`AppTheme`**: `System` (follow Windows and keep following it), `Light`, `Dark`.

| Member | Description |
|---|---|
| `Current` | The selected theme (not the resolved one). |
| `Apply(theme)` | Resolves `System` via `DetectSystemTheme()`, then replaces **only merged dictionary slot 0**. Control styles in slot 1 are parsed once and keep working because they resolve colours through `DynamicResource`, which re-evaluates when the dictionary underneath changes. Subscribes to `SystemEvents.UserPreferenceChanged` only while actually following the system, and unsubscribes on an explicit choice - leaving the handler attached would let a Windows theme change silently override the user's selection. |
| `Cycle()` | System -> Light -> Dark -> System. What the toggle button calls. |
| `OnUserPreferenceChanged` (private) | Ignores non-`General` categories and marshals onto the UI thread - `SystemEvents` fires on its own thread and touching `Application.Resources` from there throws. |
| `DetectSystemTheme()` (private static) | Reads `AppsUseLightTheme` under `...\Themes\Personalize`: `0` is dark, `1` is light, and a missing value means an older build with no dark mode, so light is the safe default. Any exception falls back to light. |

**`Themes/Light.xaml` / `Dark.xaml`** are the palettes (slot 0); **`Themes/Controls.xaml`** holds
the control styles referenced by name from the window (`HeadingText`, `MutedText`,
`SecondaryButton`, and so on).

---

## Related

- [architecture.md](architecture.md) - process model, data flow and invariants
- [agent-core.md](agent-core.md) / [agent-service.md](agent-service.md) / [agent-host.md](agent-host.md)
- [../reference/configuration.md](../reference/configuration.md) - policy fields this reads
- [../operations/diagnostics.md](../operations/diagnostics.md) - logs and tracing
