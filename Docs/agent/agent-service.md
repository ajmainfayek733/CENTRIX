# Agent.Service

The LocalSystem half of the agent, running in session 0. It owns policy, the device credential,
the SQLite store, all backend traffic, machine-wide USB events, retention, and supervision of the
per-user host. It deliberately never touches the interactive desktop.

**Output:** `Centrix.Service.exe` (`Microsoft.NET.Sdk.Worker`, self-contained, single-file,
untrimmed)
**Service name:** `CentrixAgent` - must match what the installer registers or the SCM
will not find it.
**Dependencies:** `Microsoft.Extensions.Hosting(.WindowsServices)`, `Microsoft.Extensions.Http`,
`System.Management` (WMI), `Microsoft.Win32.SystemEvents`,
`System.Security.Cryptography.ProtectedData` (DPAPI), `Agent.Core`

`PublishTrimmed` is **false** on purpose: `System.Management` resolves WMI types by reflection and
trimming silently breaks USB collection.

> Headings below are paths relative to `Windows Software_v3/src/Agent.Service/`. Note that
> `Backend/` in that context is a folder inside this project holding the HTTP client - not the
> `Backend/` API tier at the repository root.

---

## `Program.cs` - composition root

Top-level statements. Order matters in two places.

0. **`InstallConfigurator.IsConfigureRequest(args)` first, before the host builder exists.** With
   `--configure` the process is not a service at all: it is the installer asking the agent to lay
   out its own ProgramData. See below.
1. `Host.CreateApplicationBuilder(args)`, then `AddWindowsService` with
   `ServiceName = "CentrixAgent"`.
2. `AgentPaths.EnsureCreated()` - before anything writes.
3. Logging: Event Log (`CentrixAgent` source) **and** the rolling file sink with prefix
   `service`. The Event Log holds warnings and errors well but is a poor place to read a sequence
   of events from, and diagnosing a workstation usually means asking for a file rather than remote
   Event Viewer access.
4. `AgentConfiguration.Load()` inside a `try`. On failure it builds a **standalone** logger factory
   (Event Log + file, via `FileLoggerBuilderExtensions.CreateStandalone`) to record why, then
   rethrows. A service that refuses to start is exactly when the log file is the only evidence
   available.

**Registrations**

| Service                                                                                    | Lifetime                         | Note                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentConfiguration`                                                                       | singleton instance               |                                                                                                                                                                                                                                                                         |
| `AgentState`                                                                               | singleton                        |                                                                                                                                                                                                                                                                         |
| `DeviceCredentialStore`                                                                    | singleton                        |                                                                                                                                                                                                                                                                         |
| `SessionLauncher`                                                                          | singleton                        |                                                                                                                                                                                                                                                                         |
| `LocalStore`                                                                               | singleton (factory)              | Constructed **eagerly** with `Initialize()` called in the factory, so a schema failure surfaces at startup rather than on the first collector message.                                                                                                                  |
| `TelemetryQueue`                                                                           | singleton                        |                                                                                                                                                                                                                                                                         |
| `BackendClient`                                                                            | typed `HttpClient`               | Base address from `BackendClient.BuildBaseAddress`; 100 s timeout - generous enough for a screenshot upload on a slow office uplink, short enough that a black-holed connection cannot pin a sync cycle open indefinitely. User-Agent `CentrixAgent/{version}`. |
| `IpcServer`                                                                                | singleton **and** hosted service | Registered once and resolved for both roles, because `UsbWorker` depends on it for broadcasts.                                                                                                                                                                          |
| `ConnectivityWorker`, `SyncWorker`, `UsbWorker`, `RetentionWorker`, `HostSupervisorWorker` | hosted services                  |                                                                                                                                                                                                                                                                         |

---

## `Setup/InstallConfigurator.cs` - the install-time entry point

```
Centrix.Service.exe --configure --server-url <url> --enrollment-token <token>
                           [--allow-insecure-http]
```

Creates the ProgramData directories, applies their ACLs, and writes `agent.config.json`. Both
install paths call it: the MSI from a deferred, non-impersonated custom action, and
`Deploy-Agent.ps1` directly. See [decisions.md](../architecture/decisions.md) AD-15 for why this
lives in the agent rather than in the installer.

Because an MSI custom action is the caller, the contract is the **exit code**: 0 succeeded, 1 the
arguments were wrong, 2 something failed while applying them. The custom action is authored
`Return="check"`, so anything non-zero rolls the whole install back rather than leaving a
registered service with no configuration to start from. Diagnostics go to stdout and stderr, which
is where the MSI log picks them up.

| Rule                                             | Enforced because                                                                                                                                                                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server URL required, absolute, `http` or `https` | A relative or malformed address fails at first contact otherwise, on a machine nobody is watching                                                                                |
| HTTPS unless `--allow-insecure-http`             | Spec section 9. Failing at install time means a misconfigured rollout is caught on the machine being installed, rather than sending telemetry in the clear until someone notices |
| Enrollment token required                        | Without it the agent cannot enroll, and the service refuses to start                                                                                                             |

It also **registers the Event Log sources** for both processes (`CentrixAgent`,
`CentrixHost`, named in `AgentPaths` so the registered name and the opened name cannot
drift). Creating a source writes under HKLM and takes administrator privileges: the service could
do it as SYSTEM, but the host runs as the logged-on employee and cannot, and Microsoft's guidance is
to create sources "as part of an .msi installation". This is not about preventing a crash - .NET
degrades, and "when an event source can't be created... event logs are disabled" - it is about the
host not silently losing the Event Log channel an administrator goes looking in. A failure here is
warned about but does not fail the install; the file sink under ProgramData works regardless.

Identities for the ACLs come from `WellKnownSidType`, never from names like `BUILTIN\Users`: those
names are localized and do not exist on a German or Japanese install. The rules are re-applied on
every run rather than only at creation, so an upgrade over an installation whose ACLs were loosened
by hand ends up correct rather than merely unchanged.

---

## `AgentState` - `AgentState.cs`

Sealed singleton holding runtime state shared between the workers and the IPC server.

Reads happen on every collector message; writes only when policy or connectivity changes. The
policy reference is therefore swapped **atomically** rather than guarded by a lock - `AgentPolicy`
is an immutable record, so a reader sees either the whole old document or the whole new one, never
a half-applied mix.

| Member                     | Type                              | Description                                                                                                                                                     |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Policy`                   | `AgentPolicy`                     | The policy in force. Starts at the Features.md defaults so collection begins at boot rather than waiting for the first fetch. Private setter.                   |
| `ActiveUserSid`            | `string?`                         | SID of the user on the interactive desktop, learned from the host's `HelloMessage`.                                                                             |
| `BackendReachable`         | `bool`                            | Whether the last backend call succeeded. Drives the host's status indicator.                                                                                    |
| `Enrolled`                 | `bool`                            | Whether the device holds a working API key.                                                                                                                     |
| `Deactivated`              | `bool`                            | Set when an admin switches the device off. Sync stops; **collection continues** - reactivating should not leave a hole in the record for the period it was off. |
| `PolicyChanged`            | `event Action<AgentPolicy, bool>` | Raised after a swap so `IpcServer` can push to the host.                                                                                                        |
| `ApplyPolicy(AgentPolicy)` | `bool`                            | Swaps the policy and raises the event. Returns `true` when the **version actually moved**, which is what triggers a fresh consent prompt.                       |

---

## `Credentials/DeviceCredentialStore.cs`

Sealed class storing the per-device API key issued at enrollment.

Protected with DPAPI at **`LocalMachine`** scope, not `CurrentUser`: the service runs as SYSTEM and
must read the key at boot, before any user has logged on.

**Be precise about what that buys.** LocalMachine binds the ciphertext to this machine, so
`device.key` is worthless copied elsewhere. It does **not** restrict decryption to privileged
callers - Microsoft's wording is that with LocalMachine "any process running on the computer can
unprotect data", and the caution is to use it "only when you trust every account on a computer".
The fixed entropy string (`Centrix.Agent.DeviceApiKey.v3`) is compiled into an executable
that ships to every workstation, so it is obfuscation, not a secret.

The control that actually keeps a standard user away from this key is therefore the **ACL on
`%ProgramData%\Centrix`** - SYSTEM and Administrators only. Weaken that ACL and the key is
readable by anyone who can run code on the box, DPAPI or not.

Plaintext buffers are zeroed with `CryptographicOperations.ZeroMemory` after use on both paths. The
returned `string` cannot be scrubbed - strings are immutable - but the byte arrays this class owns
are not left in the heap to be swapped out or captured in a crash dump.

| Member          | Description                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HasCredential` | Whether `device.key` exists.                                                                                                                                                                                                                                                   |
| `Save(apiKey)`  | Ensures directories, protects and writes the key.                                                                                                                                                                                                                              |
| `Load()`        | Returns the key, or `null`. On `CryptographicException` it **deletes** the file and returns `null` rather than retrying forever - an undecryptable key means the file was copied from another machine or the machine was re-imaged, and the fix in both cases is to re-enroll. |
| `Clear()`       | Deletes the file; logs and swallows `IOException`.                                                                                                                                                                                                                             |

---

## `Backend/BackendClient.cs`

The agent's half of the backend API. Every call carries the device API key as a bearer token
except enrollment, which carries the org enrollment token in `X-Enrollment-Token`.

The 401/403 distinction matters and is surfaced as two exception types:

| Exception                           | Meaning                                      | Correct response                        |
| ----------------------------------- | -------------------------------------------- | --------------------------------------- |
| `DeviceUnauthorizedException` (401) | The credential is wrong                      | Discard it and re-enroll                |
| `DeviceDeactivatedException` (403)  | An admin deliberately deactivated the device | **Stop syncing** - do not retry forever |

### Delivery outcomes

Everything that uploads returns a three-way outcome rather than a boolean, because the queue must
treat the cases differently:

| Outcome                                                  | Meaning                                                | Queue does                                       |
| -------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Acknowledged / `Delivered`                               | The server confirmed it stored the data                | Mark sent                                        |
| `Rejected` (4xx)                                         | The server will refuse this identically on every retry | Advance the attempt counter toward being dropped |
| `TransientFailure` / `Transient` (network, timeout, 5xx) | The data is fine, the server is not                    | **Advance nothing** and back off                 |

Collapsing the last two would mean a week-long network outage aged out perfectly good data.

**`PushResult(Acknowledged, Rejected, TransientFailure)`** carries the per-event split for event
batches; **`UploadOutcome { Delivered, Rejected, Transient }`** is the single-item equivalent for
screenshots.

### Members

| Member                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnrollAsync(ct)`                                              | `POST api/v1/device/enroll` with `DeviceIdentity.BuildRegistration()`. Saves the returned API key. Returns `false` on a non-success status (logged); throws `DeviceDeactivatedException` on 403. Safe to call again - a re-enrolling machine is issued a fresh key.                                                                                                                                                                                                                                                     |
| `HeartbeatAsync(ct)`                                           | `GET api/v1/heartbeat`. The gate the agent must pass before syncing, and a cheap way to learn the current `PolicyVersion` without pulling the whole document.                                                                                                                                                                                                                                                                                                                                                           |
| `GetPolicyAsync(ct)`                                           | `GET api/v1/policy`. Returns `null` and logs on failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PushEventsAsync<T>(channel, events, ct)`                      | `POST api/v1/events/{channel}`, split into as many requests as the byte budget requires. Chunks go **sequentially, never in parallel** - thirty workstations draining a backlog at once is already a burst, and concurrent uploads per agent would turn a recovering server into an overloaded one. A transient failure stops the loop (the rest stays queued); a **rejection does not**, so one malformed chunk cannot block every healthy event behind it.                                                            |
| `PackIntoRequests<T>` (private)                                | Greedily packs events into requests under `MaxRequestBytes`, measuring each event's encoded UTF-8 size plus a comma. An event too large to fit alone is hopeless - no split makes it sendable - so it is reported rejected here rather than wasting a round trip to be told the same.                                                                                                                                                                                                                                   |
| `PushChunkAsync<T>` (private)                                  | Sends one request. On **413** it halves and retries via `PushHalvesAsync`, converging on something that fits - a 413 means the packing estimate and the server's limit disagree, most likely because the server was reconfigured downward, and that is recoverable without operator action. Only a single event that still will not fit is `Rejected`. Any other 4xx marks every id in the chunk `Rejected` and logs the server's response body. 5xx and network failures are `TransientFailure`.                       |
| `PushHalvesAsync<T>` (private)                                 | Recursive split-and-retry, merging the two halves' results.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `UploadScreenshotAsync(...)`                                   | `POST api/v1/screenshots` as multipart. Text fields `clientEventId`, `capturedAtUtc`, and optionally `userSid`/`width`/`height`; the JPEG under `ScreenshotFileFieldName`. A missing file returns `Delivered` - the bytes cannot be recovered, and leaving the row pending would retry a file that will never exist. 4xx -> `Rejected` (logged with the server's explanation, so a field-name mismatch is diagnosable from the agent's log alone); 5xx and network failures -> `Transient`.                             |
| `PostConsentAsync(userSid, policyVersion, acknowledgedAt, ct)` | `POST api/v1/consent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MaxRequestBytes` (private const, 900 000)                     | Byte ceiling for one events request, measured on the encoded JSON. Capping here means the agent never builds a request it knows will be refused - a full 500-event batch of activity sessions with window titles and executable paths comfortably exceeded Express's old 100 KB default, which is exactly the 413 this prevents. Deliberately well under the server's `JSON_BODY_LIMIT` (2 MB): the gap absorbs estimate error and leaves room for the server limit to be lowered without immediately breaking uploads. |
| `EnvelopeOverheadBytes` (private const, 64)                    | Allowance for the `{"events":[ ]}` wrapper when packing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ScreenshotFileFieldName` (private const)                      | **`"file"`.** Part of the wire contract, not a label - the server's multer handler accepts a single file under exactly this name and rejects anything else with `LIMIT_UNEXPECTED_FILE`. Mirrors `SCREENSHOT_FILE_FIELD` in `Backend/src/modules/ingest/upload.ts`.                                                                                                                                                                                                                                                     |
| `Authorized(method, path)` (private)                           | Builds a request with the bearer token, throwing `DeviceUnauthorizedException` if no key is stored.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ThrowIfCredentialRejectedAsync` (private static)              | Converts 401/403 into the two exception types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `BuildBaseAddress(configuration, logger)` (static)             | Normalizes the URL with a trailing slash. **Throws** `InvalidOperationException` for a non-HTTPS URL unless `AllowInsecureHttp` is set, in which case it logs a warning that telemetry is unencrypted in transit.                                                                                                                                                                                                                                                                                                       |
| `ServerDescription`                                            | The configured URL, for the host's diagnostic text.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Redact(value)` (private static)                               | `abcd...wxyz`, or `********` for short values.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ToString()`                                                   | `BackendClient(url, token=abcd...wxyz)` - the token is never logged in full.                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## `Ipc/IpcServer.cs`

Named-pipe server the per-user host connects to. Both a `BackgroundService` and a singleton
dependency of `UsbWorker`.

### Security model

The pipe ACL grants:

- SYSTEM - `FullControl`
- BUILTIN\Administrators - `FullControl`
- Authenticated Users - `ReadWrite` (excludes `ChangePermissions` and `TakeOwnership`, so a user
  cannot re-ACL the pipe)
- Anonymous - explicit **Deny**

The host runs as the logged-on employee, an ordinary user on a managed workstation, so it cannot
be restricted to elevated callers. That means a determined user could in principle connect and
submit fabricated events. **The mitigation is scope, not secrecy:** nothing on this pipe can change
policy, disable collection, or reach the backend credential, so the worst case is noise in that
user's own telemetry.

### Members

| Member                          | Description                                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecuteAsync`                  | Subscribes to `AgentState.PolicyChanged`, runs **four** concurrent accept loops so several sessions can be served at once, and unsubscribes on shutdown.                                                                                                    |
| `AcceptLoopAsync` (private)     | Creates a pipe, waits for a connection, registers it, serves it, and always cleans up. On a fault it logs and waits 2 s before reopening, so a repeatable failure (an ACL problem, say) cannot spin the CPU reopening the pipe thousands of times a second. |
| `CreatePipe()` (private static) | Builds the ACL above and calls `NamedPipeServerStreamAcl.Create` - byte mode, asynchronous, write-through, 64 KB buffers, `MaxServerInstances = 8` (more than any expected session count, so a leaked handle cannot lock out a legitimate host).            |
| `ServeAsync` (private)          | Read-handle-reply loop until the peer disconnects.                                                                                                                                                                                                          |
| `Handle(message)` (private)     | The message switch. See below.                                                                                                                                                                                                                              |
| `OnPolicyChanged` (private)     | Fire-and-forget broadcast of `PolicyUpdatedMessage`.                                                                                                                                                                                                        |
| `BroadcastAsync(message, ct)`   | Writes to every connected host. Failures are logged at Debug and swallowed - a host that died between the connection check and the write must not take down the service.                                                                                    |
| `HasConnectedHost`              | Whether any live connection exists.                                                                                                                                                                                                                         |

`_connections` is a `ConcurrentDictionary<Guid, NamedPipeServerStream>` keyed by a per-connection
id. Normally there is exactly one, but fast user switching can briefly leave two sessions with a
host running.

### Message handling

| Incoming                       | Action                                                      | Reply                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `HelloMessage`                 | Records `ActiveUserSid`, logs the host version and session  | `HelloAckMessage` with the current policy, whether consent is required (`LocalStore.HasConsented`), and `BackendReachable` |
| `SubmitAttendanceMessage`      | `TelemetryQueue.Enqueue`                                    | -                                                                                                                          |
| `SubmitActivityMetricMessage`  | `TelemetryQueue.Enqueue`                                    | -                                                                                                                          |
| `SubmitActivitySessionMessage` | `TelemetryQueue.Enqueue`                                    | -                                                                                                                          |
| `SubmitBrowserActivityMessage` | `TelemetryQueue.Enqueue`                                    | -                                                                                                                          |
| `SubmitAlertMessage`           | `TelemetryQueue.Enqueue`                                    | -                                                                                                                          |
| `SubmitScreenshotMessage`      | `TelemetryQueue.EnqueueScreenshot` (path and metadata only) | -                                                                                                                          |
| `ConsentAcknowledgedMessage`   | `LocalStore.RecordConsent`                                  | -                                                                                                                          |
| `PingMessage`                  | -                                                           | a fresh `PingMessage`                                                                                                      |
| anything else                  | logged as unexpected                                        | -                                                                                                                          |

---

## `Interop/SessionLauncher.cs`

Sealed partial class. Starts a process on the interactive user's desktop from a service running as
SYSTEM in session 0. **This is the crux of the split architecture.**

A service cannot simply `Process.Start` the host: the child would inherit session 0, where there
is no desktop, no foreground window and nothing to screenshot. The sequence is:

| Win32 call                     | Why                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WTSGetActiveConsoleSessionId` | Which session is at the physical console                                                                                                         |
| `WTSQueryUserToken`            | The logged-on user's primary token for that session                                                                                              |
| `DuplicateTokenEx`             | A primary token we are allowed to spawn with                                                                                                     |
| `CreateEnvironmentBlock`       | The user's environment, not SYSTEM's - otherwise the host gets SYSTEM's `%APPDATA%` and `%TEMP%` and would put per-user files in the wrong place |
| `CreateProcessAsUser`          | Launch on `winsta0\default`                                                                                                                      |

**`LaunchInActiveSession(executablePath, arguments = null)`** returns the new process id, or
`null` when nobody is logged on.

- Session id `0xFFFFFFFF` means no console session is attached - the machine is at the logon
  screen or between sessions. Logged at Debug; **not an error**, the supervisor simply retries.
- A `WTSQueryUserToken` failure (typically `ERROR_NO_TOKEN`) means no interactive user yet - also
  Debug, also retried.
- Genuine failures throw `Win32Exception` with the last error.
- `STARTUPINFO.lpDesktop` is `winsta0\default`. Anything else yields a process that runs but
  cannot see or draw on the user's screen.
- Creation flags: `CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW`.
- The process and thread handles are closed immediately (only the pid is needed to supervise);
  the environment block and tokens are released in a `finally`.

**Three details that are load-bearing, each from the Win32 contract rather than from taste:**

| Detail                                                                                 | Why                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lpCommandLine` is a `StringBuilder`, never a `string`                                 | The parameter is `[in, out]`: `CreateProcessAsUserW` "can modify the contents of this string", and it "cannot be a pointer to read-only memory... the function may cause an access violation". The interop marshaller can hand a native callee a pointer into a managed string's own storage, and managed strings are immutable and shared. |
| `lpApplicationName` is passed, not left `NULL`                                         | With a null application name Windows resolves an ambiguous path by trying each prefix in turn, so a planted `C:\Program.exe` would be launched instead of the agent - chosen by SYSTEM, run by the user. Microsoft's guidance is "do not pass NULL for lpApplicationName"; quoting the path is only the fallback.                           |
| The duplicated token asks for `TOKEN_QUERY \| TOKEN_DUPLICATE \| TOKEN_ASSIGN_PRIMARY` | Exactly the union the two consumers document: `CreateEnvironmentBlock` needs QUERY and DUPLICATE for a primary token, `CreateProcessAsUser` needs those plus ASSIGN_PRIMARY. It previously asked for `TOKEN_ALL_ACCESS`; nothing here impersonates or adjusts privileges.                                                                   |

Interop is `[LibraryImport]`-generated except `CreateProcessAsUser`, which uses `[DllImport]` for
its `ref STARTUPINFO` signature. Private types: `SecurityImpersonationLevel`, `TokenType`,
`PROCESS_INFORMATION`, `STARTUPINFO`.

---

## Workers

### `Workers/ConnectivityWorker.cs`

Owns the agent's relationship with the backend: enrollment, the heartbeat gate, and policy
refresh. These live in one worker rather than three because they are strictly ordered - there is
no point fetching policy with a credential that has not been proven, and none proving a credential
that has not been issued.

**Startup.** Warms the in-memory policy from `LocalStore.LoadPolicy()` before touching the network,
so a workstation that boots offline collects against the last known configuration rather than the
compiled-in defaults.

**`RunCycleAsync`** returns `true` when the agent is enrolled, heartbeating and holding fresh
policy:

1. Enroll if no credential is stored.
2. Heartbeat; bail if it fails or reports `Authenticated = false`.
3. Set `Enrolled = true`, `Deactivated = false`, `BackendReachable = true`.
4. **Only if `heartbeat.PolicyVersion != state.Policy.Version`**, fetch the full document, persist
   it, and apply it. The heartbeat is cheap and runs every few minutes; the policy document is not.

**Loop and error handling.**

| Outcome                       | Behaviour                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Healthy                       | Reset backoff, sleep `PolicyRefreshInterval` (5 min)                                                 |
| `DeviceDeactivatedException`  | Set `Deactivated`, clear `BackendReachable`, sleep **15 min**, keep collecting locally               |
| `DeviceUnauthorizedException` | Clear the stored credential and `Enrolled`, so the next cycle re-enrolls from the install-time token |
| Any other exception           | Log, clear `BackendReachable`, sleep the current backoff                                             |

Backoff is exponential from 5 s, capped at 5 min. Collection is unaffected while this loops, so a
long outage costs nothing but a delayed upload.

### `Workers/SyncWorker.cs`

Drains the local queue to the backend. The whole contract is: rows are marked sent **only** against
ids the server explicitly acknowledged, and the retention sweep is what finally removes them.

Runs only when `Enrolled && !Deactivated && BackendReachable`. The interval is
`Sync.BatchIntervalSeconds`, floored at 10 s.

**`SyncOnceAsync` order is deliberate:**

```
Attendance -> ActivitySession -> BrowserActivity -> ActivityMetric -> UsbEvent -> Alert
-> consents -> screenshots
```

Attendance and activity sessions carry the session and activity-session ids that browser visits
and USB events reference as foreign keys. Sending parents first means the server can resolve those
links instead of nulling them and losing the association.

| Method                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PushAsync<T>(channel, events, ct)`   | Pushes a batch and applies the three-way outcome: `MarkSent` for acknowledged immutable-event ids, revision-conditional `MarkAttendanceSent` for attendance snapshots, `RecordRejection` for refused ones, and on a transient failure sets `_lastCycleFailed` and clears `BackendReachable` **without touching any attempt counter**. The attendance condition prevents an old open snapshot acknowledgment from retiring a newer logout written while the request was in flight.                                                                                                                                                                                                                                                                                               |
| `SyncConsentsAsync(batchSize, ct)`    | One `POST /consent` per pending record.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SyncScreenshotsAsync(batchSize, ct)` | Uploads **one at a time**, capped at `min(batchSize, 10)` - each is a multipart request of a megabyte or more, and serial upload keeps the agent from saturating an office uplink after a long offline stretch. `Delivered` marks the row sent; `Rejected` logs an error and also retires the row, which stops the retry loop and lets `Purge` delete the orphaned JPEG (it collects the file paths of rows it removes); `Transient` abandons the whole set - pushing the remaining megabyte-scale uploads at a struggling server helps nobody. |
| `NextDelay(policy)`                   | Returns `BatchIntervalSeconds` (floored at 10 s, so a misconfigured policy cannot produce a hot loop) after a clean cycle, and **exponential backoff** after a failed one: starting at `MinRetryBackoffSeconds`, doubling, capped at `MaxRetryBackoffSeconds`, reset on the first success.                                                                                                                                                                                                                                                      |

**Why the backoff matters more than it looks:** thirty workstations lose the server at the same
moment and would otherwise retry in lockstep every batch interval for the whole outage, then all
reconnect together. Growing the delay thins that traffic out, and resetting on the first success
means a brief blip costs one slow cycle rather than minutes of silence.

Exception handling mirrors `ConnectivityWorker`: `DeviceDeactivatedException` and
`DeviceUnauthorizedException` halt syncing with a warning (re-enrollment is `ConnectivityWorker`'s
job), anything else clears `BackendReachable`, flags the cycle failed, and retains the queued data
for the next attempt.

### `Workers/UsbWorker.cs`

Sealed **partial** class (source-generated regexes). Records device connection and removal only -
never enumerates, opens, reads or copies contents.

Runs in the service rather than the host because WMI device events are machine-scoped: they arrive
whether or not anyone is logged on, so a drive plugged into a locked workstation is still recorded.

**`ExecuteAsync`** yields first (WMI subscriptions are synchronous COM plumbing; keeping them off
the startup path means a WMI stall cannot delay the rest of the service), then polls
`Usb.Enabled` every minute while disabled. `ManagementException` retries after 30 s.

**`WatchAsync`** subscribes to `__InstanceCreationEvent` and `__InstanceDeletionEvent`
`WITHIN {pollSeconds} WHERE TargetInstance ISA 'Win32_PnPEntity'`. `Win32_PnPEntity` has no push
notification, so the `WITHIN` interval **is** the detection latency; the 5 s policy default trades
a little CPU for catching a drive plugged and pulled quickly.

| Method                                     | Description                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnDeviceEvent(args, eventType)`           | Builds and enqueues the `UsbEvent`, enriches storage arrivals, logs, and raises an insertion alert if policy asks. A malformed WMI instance is caught and skipped rather than tearing down the watcher.                                                                                                         |
| `IsInterestingDevice(pnpDeviceId, target)` | Requires a `USB\`, `USBSTOR\` or `WPD\` prefix, then excludes `PNPClass` of `USB` or `System` - hubs and host controllers appear and disappear on their own during power transitions and say nothing about what a person plugged in. Every workstation enumerates dozens of internal PnP devices at boot.       |
| `ClassifyDevice(pnpDeviceId, pnpClass)`    | `USBSTOR\`/`DiskDrive` -> `UsbStorage`; `WPD\`/`WPD`/`PortableDevice` -> `MobileDevice`; `HIDClass`/`Keyboard`/`Mouse` -> `Hid`; else `Other`.                                                                                                                                                                  |
| `EnrichWithVolumeDetails(usbEvent)`        | Walks `Win32_DiskDrive` (USB interface only) and matches back to the event **by serial number** - without it two identical sticks are indistinguishable, so it skips rather than guesses. Adds capacity, drive letter, volume label and file system. Arrival-only: on removal the drive letter is already gone. |
| `FindLogicalDisk(disk)`                    | `Win32_DiskDrive` -> `Win32_DiskPartition` -> `Win32_LogicalDisk`, returning the first match's `DeviceID`, `VolumeName`, `FileSystem`.                                                                                                                                                                          |
| `RaiseInsertionAlert(usbEvent)`            | Enqueues a `Warning`-severity `UsbDeviceConnected` alert (attributed to `ActiveUserSid`, or `S-1-0-0` if nobody is logged on) and broadcasts a `ShowNotificationMessage` to the host.                                                                                                                           |
| `ExtractSerialNumber(pnpDeviceId)`         | Takes the last `\`-delimited segment and truncates at the first `&` (Windows appends interface suffixes). Returns `null` for segments under two characters, and for the `X&...` shape Windows uses to mark devices with **no real serial** - reporting those as a serial would collide across devices.          |
| `Match(pattern, input)`                    | First capture group, upper-cased, or `null`. Used with the generated `VID_([0-9A-F]{4})` and `PID_([0-9A-F]{4})` patterns.                                                                                                                                                                                      |

### `Workers/RetentionWorker.cs`

Sweeps synced rows off disk and drops undelivered ones that have aged out. Two requirements meet
here: local copies are deleted only after successful synchronization (hence "already marked sent"),
and an agent that never reaches its server must not grow without bound (hence the
`UndeliveredRetentionDays` cutoff).

Retention cleanup runs hourly. Attendance recovery runs every 30 seconds so a short service outage
cannot leave an open row behind after the host starts again. The cleanup cutoff is measured in
days, so sweeping more often would only add wakeups;
sweeping less often risks a burst of disk use between passes.

**Maintenance cycle:** calls `TelemetryQueue.RecoverOpenAttendanceSessions()` every 30 seconds -
which closes only sessions that have gone stale, never the one running now - and runs the first
hourly sweep immediately. A session left open by an unclean shutdown is therefore recovered and
uploaded rather than swept as stale, including after a short reboot.

| Method                               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sweep()`                            | Runs hourly. First calls `TelemetryQueue.DropExhausted(MaxRejectionsBeforeDrop)` and logs every dropped row at **error** level - this is data loss, so it is never quiet. Then `Purge(UndeliveredRetentionDays)`, deleting the returned orphaned screenshot files (an `IOException` from a file still held open by the uploader is caught and retried next sweep), then `SweepLogs`.                                                                                        |
| `RecoverOpenAttendanceSessions()`    | Runs every 30 seconds. A stale open row is closed as `Recovered` using `login_time + persisted active/idle seconds`; time after the last durable heartbeat is excluded because an abrupt power loss provides no observation of that interval.                                                                                                                                                                                                                               |
| `MaxRejectionsBeforeDrop` (const, 5) | How many **outright server rejections** an event survives before being discarded. Transient failures never advance the counter, so this is not a timeout - it is "the server has told us this specific event is unacceptable this many times". Five is generous enough to ride out a bad deploy that gets rolled back, and small enough that a poisoned row stops consuming a sync slot within minutes rather than sitting in the queue until the retention window expires. |
| `SweepLogs()`                        | Deletes `*.log` under `AgentPaths.LogDirectory` older than `LogRetentionDays`. The file sink prunes its own history too, but the host writes as a standard user and is intentionally denied delete rights on the log directory, so **its** files can only be removed from here. `DirectoryNotFoundException` means nothing has logged yet.                                                                                                                                  |
| `LogRetentionDays` (const, 14)       | Independent of the telemetry cutoff - logs are diagnostics, not collected data, so they are not subject to the policy's privacy-driven retention window, but they still must not grow without bound.                                                                                                                                                                                                                                                                        |

### `Workers/HostSupervisorWorker.cs`

Keeps exactly one `Centrix.Host.exe` alive on the interactive desktop.

Spec section 10 requires auto-start on boot and auto-recovery after a crash. The service half gets
that from the SCM; the host half gets it from here. Supervising from the service rather than a
per-user Run key or scheduled task means recovery does not depend on anything inside the user's own
profile, which a user could disable.

If the host executable is not found next to the service, it logs an error naming what will not run
(window, idle, input, screenshots) and returns - the service continues without it.

| Member                                                | Description                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CheckInterval` (15 s)                                | Normal verification cadence.                                                                                                                                                                                                                                                                                                                                                |
| `CrashLoopBackoff` (5 min) / `CrashLoopThreshold` (5) | If the host dies immediately on every launch - a missing dependency, a corrupt install - relaunching every 15 s forever would spam the Event Log and burn CPU, so repeated fast failures widen the interval.                                                                                                                                                                |
| `OnSessionSwitch`                                     | Subscribes to `SystemEvents.SessionSwitch`. A session change means the previous host is gone or about to be, so reacting to it brings the new user's host up in about a second. A `SessionLogon`/`ConsoleConnect` **resets** the crash-loop counter - earlier failures may have been specific to the old session. **Treat this as a bonus, not the mechanism** - see below. |

> **`SystemEvents` does not fire in this process.** Microsoft documents that these events are raised
> only if a message pump is running, and that "in a Windows service, unless a hidden form is used or
> the message pump has been started manually, this event will not be raised". This worker is a
> hosted service in session 0 with neither, so the **poll is the real guarantee** and `CheckInterval`
> is the true worst-case launch latency. If session changes ever need to be dependable here, the
> supported route is a `WindowsServiceLifetime` with `CanHandleSessionChangeEvent` set, not this
> subscription.
> | `EnsureHostRunning(hostPath)` | If the host is not running, distinguishes "died immediately" (relaunched under 30 s ago -> increment the fast-exit counter) from "ran a while then exited" (reset), then launches via `SessionLauncher`. |
> | `IsHostRunning()` | Checks by **process name**, not a remembered pid: the host can also be started by the shell during development, and a stale pid would make the supervisor launch a duplicate. Disposes every `Process` it enumerates. |
> | `ResolveHostPath()` | `Centrix.Host.exe` next to the service executable - which is why `Deploy-Agent.ps1` publishes both into the same folder. |

---

## Related

- [architecture.md](architecture.md) - process model, data flow and invariants
- [agent-core.md](agent-core.md) / [agent-service.md](agent-service.md) / [agent-host.md](agent-host.md)
- [../reference/configuration.md](../reference/configuration.md) - policy fields this reads
- [../operations/diagnostics.md](../operations/diagnostics.md) - logs and tracing
