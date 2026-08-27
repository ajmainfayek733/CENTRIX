# Agent architecture

Reference documentation for the Windows agent, whose source lives in `Windows Software_v3/`.
Every module, type and member is covered here or in the per-project documents:

| Document | Covers |
|---|---|
| [agent-core.md](agent-core.md) | Wire contracts, policy model, SQLite store, IPC framing, file logging |
| [agent-service.md](agent-service.md) | The LocalSystem service: enrollment, sync, USB, retention, host supervision |
| [agent-host.md](agent-host.md) | The per-user WPF process: collectors, alert engine, tray, disclosure window |

Feature requirements live in [features.md](features.md). The backend and dashboard tiers are
documented in [../backend/](../backend/) and [../frontend/](../frontend/); their source is in
`Backend/` and `Frontend/` at the repository root.

---

## 1. What this program is

A Windows monitoring agent for company-owned workstations. It collects attendance, foreground
application usage, active/idle time, browser navigation, input *counts*, USB device events and
optional periodic screenshots, then uploads them to an Express/Postgres backend that an admin
dashboard reads.

It is designed around a constraint that shapes nearly every file: **monitoring must be visible,
bounded, and privacy-preserving by construction rather than by configuration.** The agent runs
under its own name, shows a permanent tray indicator and a window listing what it does and does
not collect, records consent per policy version, and has no code path anywhere that can capture
a typed character.

---

## 2. Process model

The agent is two executables, deliberately.

```
Windows boot
  +- EmployeeMonitor.Service.exe          LocalSystem, session 0
       +- ConnectivityWorker              enroll -> heartbeat -> policy
       +- SyncWorker                      drain the offline queue to the backend
       +- UsbWorker                       WMI device arrival/removal
       +- RetentionWorker                 sweep synced rows, screenshots, log files
       +- HostSupervisorWorker            keep one host alive on the desktop
       +- IpcServer  --------------+      named pipe, Global\EmployeeMonitor.Agent
       +- LocalStore / TelemetryQueue     SQLite: typed tables + offline queue
                                   |
User logon                         |
  +- EmployeeMonitor.Host.exe  ----+      interactive session, standard user
       +- MonitoringOrchestrator          the single sampling loop
       +- ForegroundWindowTracker         what app is in focus
       +- BrowserUrlExtractor             address bar via UI Automation
       +- InputCounter                    key/click counts - counts only
       +- ScreenshotCapturer              full virtual desktop -> JPEG on disk
       +- SessionEventMonitor             lock/unlock/sleep/logoff
       +- AlertEngine                     idle escalation + blacklist hits
       +- TrayIconService                 visible indicator + balloons
       +- MainWindow                      disclosure + consent
```

**Why two processes.** Session 0 - where Windows services run - has no desktop. It cannot read a
foreground window title, cannot measure user idle time, and cannot capture the screen. Those
collectors *must* live in the user's session. A SYSTEM service on top provides what a user-session
process cannot: start at boot before anyone logs on, survival across logoff, supervision with
crash-loop backoff, machine-wide WMI device events, and a place to hold the device credential
that a standard user cannot read.

**The division of labour follows capability, not convenience:**

- The host **observes**. It holds no credential, opens no socket, and writes nothing durable
  except screenshot JPEGs into a shared spool directory.
- The service **decides and persists**. It owns the database, the device API key, policy, and all
  backend traffic.

The service starts the host with `WTSQueryUserToken` -> `DuplicateTokenEx` ->
`CreateEnvironmentBlock` -> `CreateProcessAsUser` on `winsta0\default`
(`Agent.Service/Interop/SessionLauncher.cs`).

---

## 3. Data flow, end to end

```
collector observes
   -> MonitoringOrchestrator builds a typed event record
   -> HostIpcClient.SendAsync           length-prefixed JSON over the named pipe
   -> IpcServer.Handle                  service side
   -> TelemetryQueue.Enqueue            SQLite row, sent_utc = NULL
   -> SyncWorker.SyncOnceAsync          POST /api/v1/events/{channel}
   -> BackendClient                     returns acknowledgedEventIds
   -> TelemetryQueue.MarkSent           only the ids the server confirmed
   -> RetentionWorker.Sweep             deletes rows already marked sent
```

Three properties fall out of this shape:

1. **At-least-once delivery.** Every event carries a client-generated `ClientEventId`. A batch
   whose HTTP response was lost is resent verbatim, and the server deduplicates on that id. Rows
   are marked sent *only* against ids the server explicitly acknowledged.
2. **Offline tolerance.** Collection never waits on the network. A workstation that boots offline
   runs on its cached policy (or the compiled-in defaults) and queues locally; the queue drains
   when connectivity returns.
3. **Delete-after-sync.** Local copies are removed only after successful synchronization - which
   is why acknowledged rows are *marked* rather than deleted inline, and swept later.

Screenshots take a parallel path: the host writes the JPEG to the shared spool directory and
sends only the **file path** over IPC. Image bytes never travel through the pipe, which would
otherwise be dominated by a multi-megabyte frame every ten minutes at the expense of
time-sensitive activity events.

---

## 4. Sync durability model

The upload path is built against a fixed list of ways bulk telemetry sync goes wrong. Each has one
mechanism responsible for it:

| Failure mode | Mechanism | Where |
|---|---|---|
| Huge backlog | **Batching** - `MaxBatchSize` events per channel per cycle (default 500) | `SyncPolicy`, `SyncWorker.SyncOnceAsync` |
| Request too large | **Hard byte budget** - events are packed into requests under `MaxRequestBytes` (900 KB), measured on the encoded JSON, so the agent never builds a body the server will refuse | `BackendClient.PackIntoRequests` |
| Network dies after upload | **Idempotency** - an unacknowledged batch is resent verbatim and the server upserts | `ClientEventId` + backend upserts |
| Duplicate events | **Unique event id** - client-generated per event, the dedup key server-side | `ITelemetryEvent.ClientEventId` |
| Server unavailable | **Exponential backoff** - `MinRetryBackoffSeconds` doubling to `MaxRetryBackoffSeconds`, reset on first success | `SyncWorker.NextDelay` |
| Client crashes | **Persistent local queue** - SQLite in WAL mode, written before anything is sent | `TelemetryQueue`, `LocalStoreSchema` |
| Partial failure | **Per-event ACK** - the server returns `acknowledgedEventIds`, not a status for the batch | `PushEventsResponse`, `PushResult` |
| Lost events | **Mark only after ACK** - rows are marked sent solely against confirmed ids, and deleted later still | `TelemetryQueue.MarkSent` -> `Purge` |
| Server overload | **Sequential, no concurrency** - channels in order, chunks in order, screenshots one at a time | `SyncWorker`, `BackendClient.PushEventsAsync` |
| Massive long-term backlog | **Retention and poison-drop** - age-based `Purge`, plus `DropExhausted` for events the server keeps refusing | `RetentionWorker` |

Two distinctions do most of the work here.

**Rejected is not the same as failed.** Every upload returns a three-way outcome - acknowledged,
rejected (4xx: the server will refuse this identically forever), or transient (network, timeout,
5xx: the data is fine, the server is not). Only *rejections* advance an event's attempt counter.
Collapsing the two would mean a week-long outage aged out perfectly good data, which is the exact
opposite of what an offline queue is for.

**A poisoned event must not block the queue behind it.** A rejection does not stop the chunk loop,
and after `MaxRejectionsBeforeDrop` (5) refusals the row is discarded with an error-level log.
Without that, one event the server will never accept is resent every cycle until the retention
window expires weeks later - thousands of pointless requests, delaying every healthy event queued
behind it.

**413 is treated as recoverable, not fatal.** If the packing estimate and the server's limit
disagree - most likely because the server was reconfigured downward - the chunk is halved and
retried until it fits. Only a single event that still will not fit is unsendable.

---

## 5. Storage rule

**No serialized documents, in Postgres or SQLite.** Every telemetry field has its own typed
column. The consequences are deliberate:

- The local queue stays inspectable with any SQL client.
- A malformed value fails at collection time rather than surfacing as a 400 from the server
  minutes later.
- The policy cache is read constantly by the service, and typed columns avoid re-parsing a blob
  on every read.

Timestamps are stored as ISO-8601 UTC round-trip strings (`"o"`). SQLite has no date type; that
format sorts lexicographically in chronological order and survives a timezone change on the
workstation, which a local-time or tick-count column would not.

JSON still exists as the *transport* encoding - HTTP bodies and IPC frames. The rule is about
storage.

---

## 6. Privacy guarantees

These are architectural, not configuration. They cannot be switched on or off by policy.

| Guarantee | How it is enforced |
|---|---|
| No keystroke content | `InputCounter` installs a low-level keyboard hook that increments a counter and returns. It never dereferences `lParam`, never decodes a virtual key code. No type in the pipeline - event DTO, SQLite column, Postgres column - has a field that could hold a character. |
| No USB contents | `UsbWorker` records connection/removal metadata only. It never enumerates, opens, reads or copies a device. |
| Not hidden | Own process name in Task Manager, entry in Installed Programs, permanent tray icon, and a window listing exactly what is and is not collected. No obfuscation. |
| Consent is recorded | Per policy version, in `consent_records`, and uploaded. A policy version change re-prompts. |
| Out-of-hours restraint | Desktop notifications are suppressed outside configured working hours unless policy explicitly allows them. |
| Only http/https URLs | `BrowserUrlExtractor` rejects `file://` and `chrome://` - local navigation is not web browsing, and file paths would capture document names. |

---

## 7. Configuration and identity

**Install-time config** (`%ProgramData%\EmployeeMonitor\agent.config.json`, written by
`Deploy-Agent.ps1`): `serverUrl`, `enrollmentToken`, `allowInsecureHttp`. The service refuses to
start without a valid server URL and token, and refuses a plain-HTTP URL unless
`allowInsecureHttp` is set (test only - spec section 9 requires TLS).

**Device identity** is the Windows `MachineGuid`
(`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`), not the MAC address. MAC is collected and
reported as an attribute, but it is spoofable and a laptop with Wi-Fi, Ethernet and a dock reports
three of them, so it is unsuitable as a key.

**Device credential**: the org enrollment token is traded exactly once for a per-device API key,
stored DPAPI-protected at `LocalMachine` scope so the SYSTEM service can read it at boot before
any user logs on.

---

## 8. Policy

`GET /api/v1/policy` returns the full document, never a diff. `AgentPolicy` and its ten
sub-records carry defaults matching Features.md, which is what the agent runs on before its first
successful fetch.

`version` is incremented by the backend on every write. The agent compares it on each heartbeat;
a change triggers a full policy fetch **and** a fresh consent prompt on the desktop. The version
must never be ignored.

Category rules (productivity / blacklist) are flattened into the policy so the agent can raise a
blacklist notification locally without a round trip. The backend re-derives the same tags at
ingest and **its answer wins** for reporting - the agent's tag is a best guess that the server
overrides whenever a rule matches.

---

## 9. On-disk layout (installed)

```
%ProgramFiles%\Employee Monitor\        both executables, published side by side
%ProgramData%\EmployeeMonitor\
    agent.config.json                   server URL + enrollment token
    device.key                          DPAPI-protected device API key
    agent.db                            typed telemetry tables + offline queue (WAL)
    screenshots\                        spool, deleted after successful upload
    logs\                               service-<date>.log, host-s<session>-<date>.log
```

ACLs are set by `Deploy-Agent.ps1`:

- The root is protected (inheritance disabled) and granted only to SYSTEM and Administrators, so a
  standard user cannot read or tamper with collected data on their own machine.
- `screenshots\` additionally grants Users **Modify** - the host writes captures there as the
  logged-on employee.
- `logs\` grants Users **Write + ReadAndExecute**, not Modify. The host must create and append to
  its own log file, but a standard user should not be able to delete or truncate the agent's
  history. Ageing log files out is therefore `RetentionWorker`'s job, running as SYSTEM.

---

## 10. Build and deploy

Both executables publish self-contained, `win-x64`, single-file, **untrimmed** - trimming breaks
`System.Management`'s reflectively-resolved WMI types and silently disables USB collection.
`Directory.Build.props` fixes the target framework, RID, version metadata and
`TreatWarningsAsErrors`.

```powershell
# From an elevated PowerShell, in "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install `
    -ServerUrl https://monitoring.example.com `
    -EnrollmentToken <token from the dashboard>
```

`Deploy-Agent.ps1` actions: `Publish`, `Install`, `Uninstall [-PurgeData]`, `Status`. Install
publishes, copies to Program Files, writes the config, sets ACLs, registers the service with
`sc.exe failure` recovery (restart after 5s twice, then 60s, counter reset daily), and starts it.

---

## 11. Logging

Both processes log to the Windows Event Log (`EmployeeMonitorAgent`, `EmployeeMonitorHost`) **and**
to rolling files under `%ProgramData%\EmployeeMonitor\logs\` via
`Agent.Core.Logging.FileLoggerProvider`.

The files are what to collect when diagnosing a workstation; the Event Log covers anything failing
before the file sink can open, and fleet monitoring that already scrapes it. File names are
prefixed per writing process (`service`, `host-s<session>`) so two processes never share a handle.
Files roll daily and at 8 MB, and are pruned after 14 days.

---

## 12. Cross-repo contracts

Three places couple this agent to the backend. A change to any of them is a two-repo commit.

| Contract | Agent side | Backend side |
|---|---|---|
| Event field names and enums | `Agent.Core/Contracts/TelemetryEvents.cs`, `Enums.cs` | `src/modules/ingest/ingest.dto.ts` (Zod schemas) |
| Channel path segments | `TelemetryChannelExtensions.ToWireName` | `CHANNELS` in `ingest.dto.ts` |
| Screenshot multipart field | `BackendClient.ScreenshotFileFieldName` (`"file"`) | `SCREENSHOT_FILE_FIELD` in `src/modules/ingest/upload.ts` |
| Request body size | `BackendClient.MaxRequestBytes` (900 KB) | `JSON_BODY_LIMIT` in `src/config/env.ts` (2 MB) |

Enum names are serialized as strings and the server rejects anything outside its own enum, so a
rename on one side alone produces a 400 on every batch.

The body-size pair is the one contract that is *deliberately* not equal: the agent's budget sits
well under the server's ceiling so that estimate error, and a server limit lowered in
configuration, both land in the headroom rather than in a 413. The agent halves and retries on a
413 regardless, so a mismatch degrades throughput rather than losing data.

---

## Related

- [agent-core.md](agent-core.md) / [agent-service.md](agent-service.md) / [agent-host.md](agent-host.md) - type-level reference
- [features.md](features.md) - the requirements this implements
- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - hops 1-5 in system context
- [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) - what couples this to the backend
- [../backend/ingest.md](../backend/ingest.md) - the server side of the sync contract
- [../operations/agent-deployment.md](../operations/agent-deployment.md) - installing and updating it
- [../operations/diagnostics.md](../operations/diagnostics.md) - agent logs and how to read them
