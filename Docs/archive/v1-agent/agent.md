> **ARCHIVED - NOT AUTHORITATIVE.** This document describes an abandoned version of the
> agent. It is kept for history only. Do not build on it.
> The live documentation index is [../../README.md](../../README.md); see
> [../../archive/README.md](../../archive/README.md) for what superseded this file.

---

# Agent.md - Employee Monitoring Agent (Windows)

This document is the governing spec for the `Agent/` project. It exists so that any
developer (or AI coding assistant) working inside this repo can implement, extend, or
review code against a single source of truth, instead of re-deriving requirements from
conversation history. Read this before writing code in any layer below.

---

## 1. What this agent is (and is not)

- It is a **disclosed, on-device activity monitor** for company-owned Windows
  workstations. Employees are informed in writing that it runs; it is never hidden
  from Task Manager, Services, or Add/Remove Programs.
- It is **not** a keylogger. It never captures typed content - only aggregate
  activity signals (active window, idle time, keystroke/mouse _counts_, not values).
- It is **not** a remote-control tool. No remote desktop takeover, no reading of
  personal email/chat content, no credential harvesting.
- It must survive **network outages, process crashes, and machine reboots** without
  losing a single recorded sample.

Every class added to this project should be checked against these four constraints
before being merged.

---

## 2. Architecture principles

The folder structure enforces **Clean Architecture / Dependency Inversion**:

- `Core/` depends on nothing. It defines _contracts_ (interfaces) and _data shapes_
  (DTOs). No Windows API calls, no HTTP, no file I/O live here.
- `Collectors/`, `Infrastructure/`, and `Services/` depend on `Core/` interfaces -
  never on each other's concrete classes directly. If `MonitoringService` needs a
  queue, it takes an `IStorageQueue`, not a `LiteDbStorageQueue`.
- `Host/` is the composition root - the _only_ place where concrete implementations
  are wired to interfaces (via DI container registration in `Program.cs`).

**Why this matters for a solo/small team**: it lets you swap the queue engine (LiteDB
-> SQLite), the sync transport (raw HttpClient -> Polly-wrapped client), or add a mock
`ITelemetry` for tests - without touching `MonitoringService` or any collector. Given
the 1-month MVP timeline, this also means Phase 2 features (screenshots, USB logging)
slot in as new classes implementing existing interfaces, not rewrites.

```
Agent/
+-- src/
|   +-- Collectors/
|   |   +-- IActivityCollector.cs
|   |   +-- AppFocusCollector.cs
|   |   +-- UrlCollector.cs
|   |   +-- IdleStateCollector.cs
|   |   +-- UsbDeviceCollector.cs        # Phase 3
|   |   +-- ScreenshotCollector.cs       # Phase 3
|   +-- Buffering/
|   |   +-- ILocalStore.cs
|   |   +-- SqliteLocalStore.cs
|   |   +-- ActivityEvent.cs
|   +-- Sync/
|   |   +-- ISyncClient.cs
|   |   +-- HttpSyncClient.cs
|   |   +-- RetryPolicy.cs
|   +-- Config/
|   |   +-- IAgentConfigProvider.cs
|   |   +-- RemoteConfigProvider.cs
|   |   +-- AgentSettings.cs
|   +-- Attendance/
|   |   +-- ISessionTracker.cs
|   |   +-- LoginLogoutTracker.cs
|   +-- Service/
|   |   +-- MonitoringWindowsService.cs
|   |   +-- CompositionRoot.cs          # DI wiring
|   +-- Program.cs
|   +-- appsettings.json
+-- installer/                          # WiX/MSI project
+-- tests/
    +-- Collectors.Tests/
    |   +-- AppFocusCollectorTests.cs
    |   +-- IdleStateCollectorTests.cs
    +-- Buffering.Tests/
    +-- Sync.Tests/
```

---

## 3. Core/ - contracts and models

### 3.1 Interfaces (`Core/Interfaces/`)

| Interface               | Responsibility                                                   | Notes                                                                                          |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `IActivityCollector`    | Produce one activity reading (app name, window title, timestamp) | Implemented by `WindowTracker`                                                                 |
| `IIdleDetector`         | Report milliseconds since last keyboard/mouse input              | Implemented by `IdleDetector`, wraps `GetLastInputInfo`                                        |
| `IBrowserTracker`       | Report active tab URL/domain, if available                       | Phase 2 - see section 8. Must degrade gracefully to `null` if extension isn't installed               |
| `IStorageQueue`         | Durable local enqueue/dequeue of pending records                 | Backed by LiteDB or SQLite - see section 5.1                                                          |
| `ISyncService`          | Batch unsynced records and POST to server                        | Wraps HttpClient + Polly - see section 5.2                                                            |
| `IConfigurationService` | Load device token, server URL, sampling/sync intervals           | Reads `appsettings.json` + encrypted secrets - see section 5.3                                        |
| `ITelemetry`            | Agent's own health/error logging                                 | Wraps Serilog - see section 5.4. Never used to log _employee_ activity, only agent operational health |

Each interface should be small enough to fake in a unit test with a hand-written
stub - if an interface grows past 3-4 methods, split it (Interface Segregation).

### 3.2 Models (`Core/Models/`)

Minimum DTO set, matching the server's `API-CONTRACT.md` field-for-field so
serialization is a straight pass-through:

```csharp
public record ActivityLog(
    string DeviceId,
    string? AppName,
    string? WindowTitle,
    string? Domain,        // null until IBrowserTracker ships (Phase 2)
    bool IsIdle,
    DateTimeOffset CapturedAt
);

public record AttendanceRecord(
    string DeviceId,
    DateOnly Date,
    DateTimeOffset FirstLogin,
    DateTimeOffset? LastLogout,
    long TotalActiveSeconds
);

public record QueuedRecord<T>(
    long LocalId,
    T Payload,
    bool Synced,
    int Attempts,
    DateTimeOffset? LastAttemptAt
);
```

DTOs are immutable (`record`) - collectors produce a reading and hand it off; nothing
downstream mutates it in place. This avoids an entire class of bugs where a queued
record is silently altered between enqueue and sync.

### 3.3 Exceptions (`Core/Exceptions/`)

Define narrow exception types so callers can react specifically instead of catching
`Exception`:

- `CollectorUnavailableException` - e.g. secure desktop (UAC/lock screen) blocks the
  read. **Caught and swallowed at the collector boundary** - never let this crash the
  sampling loop. Log via `ITelemetry`, return a null/empty reading, continue.
- `QueuePersistenceException` - local DB write failed (disk full, permissions). This
  one is serious - surface it loudly, since it threatens the "zero data loss"
  guarantee.
- `SyncAuthenticationException` - device token rejected by server (revoked/expired).
  Should stop retrying that batch and alert via `ITelemetry`, not retry forever.

---

## 4. Collectors/ - one responsibility each

Every collector implements exactly one `Core/Interfaces` contract and touches the
Windows API directly. No collector talks to the queue, the network, or another
collector - that orchestration lives in `Services/MonitoringService.cs`.

| File                   | Implements                              | Win32 / mechanism                                                                                                                    | Priority |
| ---------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `WindowTracker.cs`     | `IActivityCollector`                    | `GetForegroundWindow`, `GetWindowText`, `GetWindowThreadProcessId` -> resolve process name                                            | **M**    |
| `IdleDetector.cs`      | `IIdleDetector`                         | `GetLastInputInfo` + `GetTickCount64`                                                                                                | **M**    |
| `AttendanceTracker.cs` | (uses `IIdleDetector` + session events) | `WTSRegisterSessionNotification` (lock/unlock) or simpler: first sample of the day = login, last non-idle sample = logout            | **M**    |
| `BrowserTracker.cs`    | `IBrowserTracker`                       | Native message host listening on localhost port; paired with a Chrome/Edge/Firefox extension reading `tabs.query` for the active tab | **S**    |
| `UsbDeviceLogger.cs`   | (new interface `IUsbMonitor` if added)  | WMI event subscription on `Win32_VolumeChangeEvent`                                                                                  | **C**    |

### P/Invoke guidance for `WindowTracker` / `IdleDetector`

Use `System.Runtime.InteropServices` directly - no third-party wrapper needed for
these two calls, they're stable Win32 APIs:

```csharp
[DllImport("user32.dll")]
static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

[DllImport("user32.dll")]
static extern IntPtr GetForegroundWindow();

[DllImport("user32.dll")]
static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
```

**Fail-safe rule**: if any of these calls fail or throw, the collector must return a
"no reading" result (never a false-idle or false-active guess). Getting this wrong
either falsely flags someone as idle all day or fails to detect real idle time - both
undermine trust in the whole system.

**UAC / secure desktop**: `GetForegroundWindow` returns a handle into the _user's_
desktop, not the secure desktop (UAC prompts, Ctrl+Alt+Del, lock screen). Expect
`GetWindowText` to occasionally return empty - this is correct OS behavior, not a bug
to work around.

---

## 5. Infrastructure/ - the plumbing

### 5.1 Queue/ (durable local storage)

- **Engine**: LiteDB (pure .NET, no native dependency, works well as an embedded
  queue) or SQLite via `Microsoft.Data.Sqlite` - either satisfies the requirement;
  LiteDB is slightly simpler to wire in a single-file .NET service with no external
  DLLs to ship.
- **Schema mirrors `QueuedRecord<T>`**: `LocalId` (auto), `Payload` (serialized JSON),
  `Synced`, `Attempts`, `LastAttemptAt`.
- **Write path**: every collector reading is enqueued immediately after capture -
  never held in memory only.
- **Read path**: `ISyncService` pulls unsynced batches (e.g. 200 rows), never
  deletes on read - only marks `Synced = true` after server confirms.
- **Retention**: a scheduled purge (`purge synced older than N days`, N configurable,
  default 90) keeps the local file from growing unbounded - required by the spec's
  configurable-retention clause.

### 5.2 Sync/ (HttpClient + Polly)

This is where "no data loss on network drop" actually gets enforced:

```csharp
services.AddHttpClient<ISyncService, SyncService>()
    .AddTransientHttpErrorPolicy(policy => policy.WaitAndRetryAsync(
        retryCount: 5,
        sleepDurationProvider: attempt => TimeSpan.FromSeconds(Math.Pow(2, attempt))))
    .AddTransientHttpErrorPolicy(policy => policy.CircuitBreakerAsync(
        handledEventsAllowedBeforeBreaking: 5,
        durationOfBreak: TimeSpan.FromMinutes(2)));
```

- **Retry with exponential backoff** absorbs transient network blips without
  hammering the server.
- **Circuit breaker** stops trying entirely for a cooldown window after repeated
  failures - protects both the agent's battery/CPU and the server from a retry storm
  when 30-100 agents all lose connectivity at once (e.g. office router restart).
- **Idempotency key** per batch (hash of the `LocalId` set) sent as a request header
  - required so a batch that succeeded server-side but whose response was lost
  doesn't get double-inserted on retry. This must be implemented on both agent and
  server sides; it does nothing alone.
- Auth: **device token** (not user JWT) in the `Authorization` header, loaded via
  `IConfigurationService`. This is a machine credential, issued once at install time
  - never a human login.

### 5.3 Config/

- `appsettings.json` holds non-secret defaults: sample interval (default 15s), sync
  interval (default 2 min), idle threshold (default 5 min).
- **Secrets** (device token, server URL) are set at install time and encrypted at
  rest using Windows DPAPI (`ProtectedData.Protect`, scoped to `LocalMachine` since
  the service runs without a logged-in user context). Never store the token in plain
  text in `appsettings.json`.

### 5.4 Logging/

- Serilog, with a **file sink** (rolling daily, capped size) always on, and an
  **optional server sink** (a lightweight "agent health" endpoint, separate from the
  activity-ingest endpoint) for centralized troubleshooting across 30-100 machines.
- **Hard rule**: this logger is for _agent operational health_ (crashes, sync
  failures, collector errors) - it must never log activity content (window titles,
  URLs). Mixing the two creates a second, unaudited channel for the exact data the
  compliance requirements in the parent spec are meant to control.

---

## 6. Services/ - orchestration

### `MonitoringService.cs`

The orchestrator. Owns two independent timers (not one shared loop - see rationale
below):

- **Sample timer** (every 15s): calls `IActivityCollector` + `IIdleDetector`, builds
  an `ActivityLog`, enqueues via `IStorageQueue`. Wrapped in try/catch per section 3.3 - a
  collector failure never stops this timer.
- **Sync timer** (every 1-5 min, configurable): calls `ISyncService.SyncPendingAsync()`.

**Why two independent timers, not one loop with awaits**: if sampling and syncing
shared a single loop, a slow or hanging network call would delay or skip samples.
Decoupling guarantees a dead network never degrades data collection quality - only
sync freshness.

### `ScreenshotService.cs` (S - should-have, Phase 2)

- Off by default. Toggle lives in agent config, controlled remotely by admin
  settings (server pushes config, agent polls/applies it).
- When enabled: captures on its own timer (default 10 min), encrypts the image at
  rest before queuing (per parent spec section 9 - "encrypt sensitive data at rest,
  especially screenshots"), and reuses the _same_ `IStorageQueue`/`ISyncService`
  pattern as activity logs - don't build a parallel pipeline for this.

### `UpdateService.cs` (C - could-have, later)

- Checks a version endpoint, downloads a signed installer, and hands off to the
  Windows Installer for an in-place upgrade. Deferred past the 1-month MVP - see section 8.

---

## 7. Host/ - composition root

- `Program.cs`: builds the Generic Host, registers all interface->implementation
  bindings via DI, reads config, starts the host.
- `Worker.cs`: a `BackgroundService` whose `ExecuteAsync` simply starts
  `MonitoringService` and awaits the host's cancellation token - keep this thin, all
  real logic belongs in `Services/`.
- `Installer/`: wraps installation as a genuine **Windows Service** (auto-start,
  auto-restart on failure via `sc.exe failure` config or a WiX-generated MSI). The
  service must be:
  - **Visible** - a real named service ("CompanyActivityMonitor"), visible in
    `services.msc` and Task Manager. No hiding, no process-name spoofing. This is a
    hard compliance requirement, not a style choice.
  - **Signed** - ship with a code-signing certificate. An unsigned background
    service that reads foreground windows will get flagged by Defender/SmartScreen
    regardless of intent; this is an operational necessity for 30-100 silent
    installs, not optional polish.

---

## 8. Phase mapping (ties back to the 1-month MVP scope)

| Component                                                                                                           | Priority | Month-1 MVP?                                       |
| ------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------- |
| `WindowTracker`, `IdleDetector`, `AttendanceTracker`                                                                | M        | **Yes**                                            |
| `Core/Interfaces`, `Models`, basic `Queue/`, basic `Sync/` (retry only, no circuit breaker yet if time-constrained) | M        | **Yes**                                            |
| `IConfigurationService`, `ITelemetry` (file sink only)                                                              | M        | **Yes**                                            |
| Windows Service installer, code signing                                                                             | M        | **Yes** - required to deploy to 30 machines at all |
| `BrowserTracker` (URL tracking)                                                                                     | S        | Defer                                              |
| `ScreenshotService`                                                                                                 | S        | Defer                                              |
| Polly circuit breaker (retry alone is acceptable for MVP)                                                           | S        | Defer if time-constrained                          |
| `UsbDeviceLogger`                                                                                                   | C        | Defer                                              |
| `UpdateService` (auto-update)                                                                                       | C        | Defer                                              |

This mirrors the priority letters from the original technical spec - every deferred
item here is explicitly S or C priority there, so cutting it for month 1 doesn't
contradict the client-agreed scope.

---

## 9. Non-functional requirements (binding for all layers)

| Requirement        | Target                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| CPU footprint      | < 3% average, no visible slowdown for the employee                                                    |
| Memory             | Low, stable - no unbounded growth from the local queue (enforced by retention purge)                  |
| Offline resilience | Zero data loss across network drops - enforced by `IStorageQueue` durability                          |
| Crash recovery     | Windows Service auto-restart; on restart, resume from queue - no re-reading of already-queued samples |
| Scale              | Comfortably 30 agents now, must not require architectural rework at 100                               |

---

## 10. Testing (`Tests/`)

- **Unit tests** for every `Collectors/` class using a faked Win32 layer (wrap P/Invoke
  calls behind a thin internal interface so `WindowTracker` itself is testable without
  a real desktop session).
- **Unit tests** for `ISyncService` retry/circuit-breaker behavior using a fake
  `HttpMessageHandler` that simulates timeouts and 5xx responses.
- **Integration test**: run the full sample -> queue -> sync loop against a local test
  server, kill network mid-run, confirm zero rows are lost and no rows are
  duplicated after reconnect.
- Treat "zero data loss" and "no duplicate ingestion" as **acceptance-blocking**
  tests, not nice-to-haves - these are the two guarantees the whole business
  relationship depends on.

---

## 11. Definition of done (month-1 MVP)

- All 30 target machines run the signed installer silently and appear as a visible,
  named service.
- Agent samples reliably, survives reboot and network loss, and every sample
  eventually reaches the server with no duplicates.
- No typed keystroke content, no screen takeover, no hidden process - verified by
  manual audit against section 1 before shipping.
