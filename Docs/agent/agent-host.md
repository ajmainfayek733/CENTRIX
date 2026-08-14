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
| `OnExit` | Cancels the reconnect loop, allows the window to really close, disposes the tray, disposes `InputCounter` (unhooks) and `SessionEventMonitor` (unsubscribes), stops the host with a **5 s bound** so a wedged worker cannot hang logoff, then disposes the IPC client and mutex. |

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
| `ConnectAsync(ct)` | Connects with a **3 s** timeout (the caller retries on a schedule, and a long block would delay collectors starting when the service simply is not up yet), sends `HelloMessage` carrying the user SID, name, terminal-services session id and host version, then starts the read loop. Returns `false` on `TimeoutException`, `IOException` or `UnauthorizedAccessException`. |
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
| `ResolveProcess(pid)` (private) | Resolves the executable path and `FileDescription`. `MainModule` throws for protected and cross-bitness processes - a standard-user agent cannot read an elevated process's modules - which is expected, not an error: it falls back to the process name and keeps going. |
| `_processCache` / `ProcessCacheLimit` (256) | Path lookups hit the process table and are comparatively slow, so results are cached per pid. At the limit the **whole cache is cleared** rather than evicting LRU - crude but adequate, and pids are only reused after a wrap, where a stale entry would attribute time to the wrong application. |

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

The tradeoff is that UIA calls cross a process boundary and can block if the browser is busy, so
every lookup runs under a policy-supplied timeout and a failure degrades to "no URL this tick"
rather than stalling the collector.

**`BrowserVisit`** (sealed record): `Browser`, `RawUrl`, `Domain`, `Protocol`, `PageTitle?`,
`ProfileName?`.

| Member | Description |
|---|---|
| `TryExtract(snapshot, timeoutMs, maxRetryAttempts)` | Returns a visit or `null`. Runs `ReadAddressBar` on a worker with a **hard timeout** - UI Automation has no cancellation of its own, so a hung browser would otherwise block this thread indefinitely and stop *all* activity tracking, not just browser tracking. Catches `ElementNotAvailableException`, `AggregateException` and `InvalidOperationException` (the window closed or navigated mid-read - normal during browsing). |
| `_failureCounts` | Consecutive failures per process name. Chromium windows still painting return nothing for the first tick or two; a browser that never yields a URL (an unsupported fork, a hardened build) stops being retried once it exceeds `maxRetryAttempts`. Cleared on success. |
| `ReadAddressBar(windowHandle)` (private static) | Finds descendant `Edit` controls with a `ValuePattern`. Prefers one whose name contains `Address`, `Search with` or `Search or enter` (Chromium marks the omnibox this way, and a page can contain other edits); otherwise falls back to the first non-empty edit value. |
| `TryNormalizeUrl(raw, out uri)` (private static) | Browsers hide the scheme, so `github.com/anthropics` needs `https://` prepended before it will parse. A bare search phrase is rejected by requiring a dot in the authority - this keeps `how do I center a div` out while letting `github.com/anthropics` through. **Only `http` and `https` are accepted**: a `file://` path or `chrome://settings` is local navigation, not web browsing, and logging file paths would capture document names the spec's purpose-limitation rule does not cover. |
| `DerivePageTitle(windowTitle, browser)` (private static) | Strips the per-browser suffix (` - Google Chrome`, ` - Mozilla Firefox`, etc.) so the stored page title is just the page. Edge is matched with and without its zero-width-space variant. |

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

**`GetIdleTime()`** returns the time since the last keyboard or mouse input anywhere in the
session. `GetLastInputInfo` and `GetTickCount` both report 32-bit millisecond counters that wrap
after ~49.7 days of uptime; subtracting them as **unsigned** handles the wrap correctly, so a
long-uptime workstation does not suddenly report a 49-day idle time.

---

## Services

### `Services/MonitoringOrchestrator.cs`

`BackgroundService`. Drives every interactive collector and turns their observations into typed
telemetry events.

**One loop rather than a timer per collector**, because attendance, activity sessions, browser
visits and the idle state all depend on the same "what is happening right now" reading. Sampling
them independently would let them disagree - an activity session recorded as `Application` while
the idle monitor already considers the user away.

**State**

| Field | Purpose |
|---|---|
| `_userSid`, `_sessionId`, `_loginTime` | Identify this logon session. `_sessionId` is a fresh GUID per host start and is the foreign key every event carries. |
| `_current` (`ActivitySegment`) | In-progress foreground activity session: `ActivitySessionId`, `Snapshot`, `Type`, `StartedAt`. |
| `_currentVisit` (`BrowserSegment`) | In-progress browser visit: `BrowserActivityId`, `ActivitySessionId`, `Visit`, `WindowTitle`, `StartedAt`. |
| `_lastMetricFlush`, `_lastScreenshot`, `_lastAttendanceFlush` | Interval bookkeeping. |
| `_totalActiveSeconds`, `_totalIdleSeconds` | Running attendance totals. |
| `MetricFlushInterval` (1 min) | How often the activity metric window is closed and sent. |
| `AttendanceFlushInterval` (2 min) | How often the open attendance row is refreshed - frequent enough that a power loss loses at most this much of the day, cheap enough not to matter since it is an upsert on one row. |

**Lifecycle**

`ExecuteAsync` subscribes to the session events, wires on-demand screenshots, and **opens the
attendance record immediately** (a session that is never opened cannot be closed). It then loops at
`AppSession.PollSeconds` (clamped 1-60 s), catching per-tick exceptions so one bad tick - a window
that vanished mid-read, a UIA hiccup - does not stop monitoring for the rest of the session. On
exit it closes the current segment with `SessionEnd` and flushes a final attendance row: closing
cleanly is the difference between an accurate logout time and a `Recovered` one on the next start.

**`TickAsync`**

1. Read idle time and resolve the current state.
2. Accumulate active or idle seconds.
3. Start a new segment when the state changes, or when the focused app/title changes.
4. If `Application`: track the browser and evaluate application alerts. Otherwise close any open
   browser visit.
5. Evaluate idle alerts.
6. Flush metrics and attendance on their intervals; capture a screenshot if due.

| Method | Description |
|---|---|
| `ResolveState(policy, idleTime, idleThreshold)` | Precedence is **lock beats idle**: a locked screen is locked whether or not the idle timer elapsed, and reporting it as `Idle` would lose why the user stopped. Then `!Activity.Enabled` -> `Desktop`; `idleTime >= threshold` -> `Idle`; a captured snapshot -> `Application`; `null` snapshot -> `Desktop`. |
| `DetermineEndReason(previous, next)` | Maps the incoming state to an `ActivityEndReason` - `Idle` -> `UserInactivity`, `Locked` -> `ScreenLock`, `Sleeping` -> `Sleep`, `Disconnected` -> `Disconnect`, otherwise `AppSwitch`. |
| `CloseCurrentSegmentAsync(reason, ct)` | Computes the duration, **discards sub-second segments** (noise from rapid alt-tabbing that would flood the store), closes any browser visit, tags via `PolicyEvaluator.MatchApplication`, and submits `SubmitActivitySessionMessage`. |
| `TrackBrowserAsync(policy, snapshot, now, ct)` | Closes the visit if browser monitoring is off or the app is not a browser. Otherwise extracts the URL; an unchanged `RawUrl` is the same visit, a changed one closes the old segment and opens a new one linked to the containing activity session, then evaluates domain alerts. |
| `CloseBrowserVisitAsync(now, ct)` | Same sub-second rule, tags via `PolicyEvaluator.MatchDomain`, submits `SubmitBrowserActivityMessage`. A `Guid.Empty` activity-session link is normalized to `null`. |
| `FlushMetricsAsync(now, ct)` | Drains the input counters and submits the window. **A window with no input at all is skipped** - the idle activity session already records that the user was away. |
| `FlushAttendanceAsync(logoutTime, reason, ct)` | Writes the attendance row. Called periodically with `null`s to refresh the running totals, and with a concrete time and reason when the session actually ends. `WorkDate` is the **local** date, because attendance is reported against the employee's own working day. |
| `CaptureScreenshotAsync(ct)` | Captures off the UI thread and submits the path and metadata. |
| `OnSessionSuspended(reason)` | **Fire-and-forget** on purpose: this runs on a `SystemEvents` callback Windows expects to return promptly - on shutdown it has only seconds before the process is killed. Closes the segment with the mapped reason and flushes the final attendance row. |
| `OnSessionResumed()` | Resets the metric window start, so time asleep is not counted as a measurement window. |
| `Dispose()` | Unsubscribes from the session events. |

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
