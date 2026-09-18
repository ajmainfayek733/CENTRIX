# Agent.Core

Shared library referenced by both executables. It holds everything that must mean the same thing
on both sides of the process boundary: wire contracts, the policy model, the local database, IPC
framing, well-known paths, device identity, and the file logging sink.

**Output:** `Agent.Core.dll` (library)
**Dependencies:** `Microsoft.Data.Sqlite`, `SQLitePCLRaw.bundle_e_sqlite3` (pinned to 3.0.5 -
the version Microsoft.Data.Sqlite resolves by default carries GHSA-2m69-gcr7-jv3q),
`Microsoft.Extensions.Logging(.Abstractions)`, `Microsoft.Extensions.Options`

`Microsoft.Data.Sqlite` rather than EF Core: the schema is a fixed set of typed telemetry tables
written by hand-rolled SQL, and a background service on 30 workstations needs neither a change
tracker nor a migrations engine.

---

## `AgentPaths` - `AgentPaths.cs`

Static class. Well-known on-disk locations, all rooted at
`%ProgramData%\Centrix`. Only the service touches the database and credential files; the
host submits everything over the pipe. That split is what allows the directory ACL to deny
ordinary users write access to collected data without breaking the host.

| Member                     | Type           | Description                                                                                                                                                                                                       |
| -------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RootDirectory`            | `string`       | `%ProgramData%\Centrix`. Computed once at type initialization.                                                                                                                                            |
| `DatabasePath`             | `string`       | `agent.db` - typed local store and offline queue.                                                                                                                                                                 |
| `ConfigPath`               | `string`       | `agent.config.json` - server URL and enrollment token, written by the installer.                                                                                                                                  |
| `CredentialPath`           | `string`       | `device.key` - DPAPI-protected device API key, written by the service after enrollment.                                                                                                                           |
| `ScreenshotSpoolDirectory` | `string`       | `screenshots\` - captures staged here until uploaded, then deleted.                                                                                                                                               |
| `LogDirectory`             | `string`       | `logs\` - rolling log files from both processes.                                                                                                                                                                  |
| `IpcPipeName`              | `const string` | `Global\Centrix.Agent`. The `Global\` prefix scopes the pipe across terminal-services sessions, which is **required** because the service (session 0) and host (user session) live in different sessions. |
| `EnsureCreated()`          | `void`         | Creates the root, screenshot spool and log directories. Idempotent. Called at service startup, by `LocalStore`'s constructor, by `DeviceCredentialStore.Save`, and before each screenshot write.                  |

---

## Configuration

### `AgentConfiguration` - `Configuration/AgentConfiguration.cs`

Sealed record. Install-time configuration read from `AgentPaths.ConfigPath`. It carries the
org-wide enrollment token, which is not itself a telemetry credential (the backend refuses it on
every route except enrollment) but does let a machine join the fleet - hence the ACL requirement.

| Member              | Type                 | Description                                                                                                                                                                                                                                        |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServerUrl`         | `required string`    | Base URL of the monitoring server.                                                                                                                                                                                                                 |
| `EnrollmentToken`   | `required string`    | Org enrollment token from the dashboard. Traded once for a per-device API key.                                                                                                                                                                     |
| `AllowInsecureHttp` | `bool`               | Permits a plain-HTTP `ServerUrl`. Lab and smoke-test only; the service logs a warning on every start when set.                                                                                                                                     |
| `static Load()`     | `AgentConfiguration` | Reads and validates the file. **Throws** `FileNotFoundException` if absent, `InvalidDataException` if unparseable or if either required field is blank. This is a hard dependency - the service fails loudly at startup rather than running blind. |
| `Save()`            | `void`               | Writes the file (after `EnsureCreated`). Used by the installer and developer setup.                                                                                                                                                                |

---

## Contracts - `Contracts/`

The client half of the backend's ingest API. Property names serialize to camelCase and mirror the
backend's Zod schemas field for field.

### `AgentJson` - `Contracts/AgentJson.cs`

Static class holding the single `JsonSerializerOptions` used for **both** backend HTTP calls and
named-pipe IPC.

| Member                   | Description                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Options`                | `JsonSerializerDefaults.Web` plus: camelCase naming, case-insensitive reads, `WhenWritingNull` ignore condition, and `AllowReadingFromString` number handling. |
| `Serialize<T>(T)`        | Serializes with `Options`.                                                                                                                                     |
| `Deserialize<T>(string)` | Deserializes with `Options`. Returns `null` for JSON `null`.                                                                                                   |

> The project's "no JSON" rule is about _storage_. Nothing is persisted as a serialized document
> in Postgres or SQLite. JSON remains the transport encoding, which is what this configures.

### `Enums.cs`

Twelve string-serialized enums (each with an explicit `JsonStringEnumConverter<T>`), forming the
client half of the backend's Postgres enums. **Names must match `ingest.dto.ts` exactly** - they
travel as strings and the server rejects anything outside its own enum.

| Enum                | Members                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `ActivityType`      | `Application`, `Desktop`, `Locked`, `Idle`, `Sleeping`, `Disconnected`                                |
| `ActivityEndReason` | `UserInactivity`, `ScreenLock`, `Sleep`, `Disconnect`, `AppSwitch`, `SessionEnd`                      |
| `ProductivityTag`   | `Productive`, `Unproductive`, `Blacklisted`, `Neutral`                                                |
| `SessionEndReason`  | `Logout`, `Lock`, `Shutdown`, `Restart`, `Hibernate`, `Sleep`, `PowerLoss`, `Disconnect`, `Recovered` |
| `UsbEventType`      | `Connected`, `Disconnected`                                                                           |
| `UsbDeviceType`     | `UsbStorage`, `MobileDevice`, `Hid`, `Other`                                                          |
| `BrowserKind`       | `Chrome`, `Edge`, `Firefox`, `Brave`, `Opera`, `Vivaldi`, `Other`                                     |
| `UrlProtocol`       | `Http`, `Https`                                                                                       |
| `AlertSeverity`     | `Information`, `Warning`, `High`, `Critical`                                                          |
| `AlertState`        | `New`, `Shown`, `Acknowledged`, `Resolved`, `Archived`                                                |
| `AlertType`         | `IdleThreshold`, `BlacklistedApp`, `BlacklistedWebsite`, `UsbDeviceConnected`                         |
| `CategoryTarget`    | `Application`, `Domain`                                                                               |

`SessionEndReason.Recovered` is special: it means the session was still open when the agent
restarted, so the logout time is the last persisted heartbeat rather than an observed logoff.

**`TelemetryChannel`** (not string-serialized) enumerates the six ingest channels.
**`TelemetryChannelExtensions.ToWireName(this TelemetryChannel)`** maps them to URL path segments
(`attendance`, `activity-metric`, `activity-session`, `browser-activity`, `usb-event`, `alert`) and
throws `ArgumentOutOfRangeException` on an unknown value.

### `TelemetryEvents.cs`

#### `ITelemetryEvent`

Interface with a single member, `Guid ClientEventId`. Every event carries a client-generated id
because sync is at-least-once - a batch whose HTTP response was lost is resent verbatim and the
server deduplicates on this id. `BackendClient.PushEventsAsync` is generically constrained to it.

#### `AttendanceEvent`

One per uninterrupted stretch of presence - not per Windows logon session. Upserted server-side on
`SessionId`: an open session re-sends the row every couple of minutes as its running totals grow.

**Once `LogoutTime` is set the row is closed and accepts no further writes.** A lock, a suspend or a
logoff ends the session; presence resumed afterwards arrives as a **new** `SessionId` with its own
login time, so a day is several rows and its first login and last logout are the earliest and latest
across them. The store and the ingest layer both enforce this, because the periodic refresh sends a
null `LogoutTime` to mean "still open" and letting one land on a closed row blanks a logout that has
already been reported.

`ClientEventId`, `SessionId`, `Revision`, `UserSid`, `LoginTime`, `LogoutTime?`, `EndReason?`,
`WorkDate`, `TotalActiveSeconds`, `TotalIdleSeconds`.

`Revision` says **which snapshot of the session this is** - 1 for the row as first written, bumped
on every rewrite. One session is reported many times (open with no seconds on it, open with two
minutes, closed) and the queue is at-least-once over a link that can be down for hours, so the
server sees these out of order and cannot tell a newer report from a redelivered older one by
looking at it. This states the answer instead of leaving it to be inferred. Assigned by
`TelemetryQueue` on write, **never by a caller**.

`WorkDate` is a local calendar date (`yyyy-MM-dd`) sent by the agent because only the workstation
knows its own timezone - a late shift would otherwise land on the wrong date.

`TotalActiveSeconds` and `TotalIdleSeconds` are the **sum of the activity sessions the agent has
already sent**, plus whatever the open segment has run for at the moment of the flush. They are not
counted independently, so the attendance row and the activity log cannot disagree. See
[agent-host.md](agent-host.md#how-time-is-measured).

#### `ActivityMetricEvent`

Input counts over a closed time window. `ClientEventId`, `SessionId`, `KeyCount`, `MouseCount`,
`MouseLeftKeyCount`, `MouseRightKeyCount`, `MouseMiddleKeyCount`, `MouseOtherKeyCount`,
`WindowStartUtc`, `WindowEndUtc`.

> **Privacy.** There is deliberately no field on this type capable of carrying a key, a character
> or a sequence. The collector increments counters without ever inspecting the virtual key code.

#### `ActivitySessionEvent`

One per foreground app, idle, lock or sleep interval. `ClientEventId`, `ActivitySessionId`,
`SessionId`, `AppName?`, `ProcessName?`, `ExecutablePath?`, `Type`, `WindowTitle?`, `StartTime`,
`EndTime`, `DurationSeconds`, `Reason?`, `ProductivityTag` (default `Neutral`).

`ProductivityTag` is the agent's best guess from its cached policy. The server re-derives it from
the admin's current rules and keeps the agent's value only when no rule matches.

#### `BrowserActivityEvent`

One per distinct URL visit. `ClientEventId`, `BrowserActivityId`, `ActivitySessionId?`, `Browser`,
`BrowserVersion?`, `ProfileName?`, `Domain`, `RawUrl`, `WindowTitle?`, `PageTitle?`, `Protocol`
(default `Https`), `StartTime`, `EndTime`, `DurationSeconds`, `ProductivityTag`.

`ActivitySessionId` links the visit to the foreground app session that contained it.

#### `UsbEvent`

Connection and removal metadata only. `ClientEventId`, `SessionId?`, `EventType`, `DeviceType`,
`FriendlyName?`, `Manufacturer?`, `Model?`, `SerialNumber?`, `VendorId?`, `ProductId?`,
`DriveLetter?`, `VolumeLabel?`, `CapacityBytes?`, `FileSystem?`, `EventTime`.

`CapacityBytes` is a **decimal string**, not a number: drive capacities exceed JSON's safe integer
range, and the backend stores it in a `BIGINT` column.

#### `AlertEvent`

`ClientEventId`, `UserSid`, `Type`, `Severity`, `State` (default `New`), `Title`, `Message`, the
typed context fields (`IdleSeconds?`, `ThresholdSeconds?`, `ContextAppName?`,
`ContextProcessName?`, `ContextDomain?`, `ContextUrl?`, `ContextUsbSerialNumber?`,
`ContextUsbFriendlyName?`), `TriggeredAt`, `AcknowledgedAt?`, `ResolvedAt?`, `LastNotifiedAt?`,
`EscalationLevel`, `NotificationCount`.

Which context fields are populated depends on `Type`. An escalating incident **reuses one
`ClientEventId`** across escalations, so the server upserts and the dashboard shows one incident
that grew rather than three unrelated alerts.

#### Enrollment and response DTOs

| Type                 | Purpose                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DeviceRegistration` | Device profile sent at enrollment: `DeviceId`, `DeviceName`, `SystemType?`, `Edition?`, `Version?`, `MacAddress`, `AgentVersion?`. |
| `EnrollmentResponse` | `Authenticated`, `ApiKey?`, `DeviceId?`, `EmployeeId?`, `Error?`. The API key is returned exactly once.                            |
| `HeartbeatResponse`  | `Authenticated`, `DeviceId?`, `PolicyVersion`, `ServerTimeUtc`. `PolicyVersion` is what lets the agent skip a full policy fetch.   |
| `PushEventsResponse` | `AcknowledgedEventIds` - only these are marked sent locally.                                                                       |

---

## `DeviceIdentity` - `DeviceIdentity.cs`

Static class building the device profile.

| Member                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GetMachineGuid()`       | Reads `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` (64-bit view). Stable for the life of the OS install and unaffected by hardware swaps, renames or re-IPing. Falls back to `fallback-{MachineName}` rather than crash-looping at boot.                                                                                                                                                                                                                                                            |
| `GetPrimaryMacAddress()` | MAC of the best available adapter, or **`null`** when none can be determined. Searched in tiers: (1) up, physical, non-virtual; (2) any non-virtual, whatever its operational status; (3) anything left, including virtual adapters. Within a tier, Ethernet before Wi-Fi before the rest, then by adapter id so the pick is stable. Loopback and tunnel adapters are always skipped, as is any adapter reporting an empty or all-zero address. The first real answer is cached for the process lifetime. |

> **Why the tiers.** The earlier version required an adapter that was `Up` _and_ physical _and_
> not virtual-sounding, and returned `00:00:00:00:00:00` when nothing matched. All three
> conditions fail routinely - the service starts at boot and enrolls before any adapter reaches
> `Up`; a laptop on Wi-Fi with the dock unplugged has no Ethernet; on a host running Hyper-V or
> WSL2 the adapter carrying traffic is described as virtual. The zero address was not an edge
> case, it was the common result, and because it is a well-formed string nothing downstream could
> tell it apart from a real one: every affected device showed the same MAC in the dashboard.
>
> `DeviceRegistration.MacAddress` is nullable for the same reason, and the backend normalizes what
> it receives - canonical uppercase colon form, with the all-zero address stored as `NULL`. "We do
> not know" is a fact worth recording accurately.
> | `GetEdition()` | `ProductName` from `CurrentVersion` (e.g. `Windows 11 Pro`), falling back to `RuntimeInformation.OSDescription`. Read from the registry rather than inferred from the build number. |
> | `GetOsVersion()` | `Environment.OSVersion.Version` (e.g. `10.0.26200`). Accurate only because `app.manifest` declares Windows 10/11 support - without it Windows reports 6.2. |
> | `GetSystemType()` | System Information wording, e.g. `64-bit operating system, x64-based processor`. |
> | `GetAgentVersion()` | Reads the `AgentVersion` assembly metadata written by `Directory.Build.props`, falling back to the assembly version, then `0.0.0`. |
> | `BuildRegistration()` | Assembles a `DeviceRegistration` from all of the above. |

> Identity is `MachineGuid`, not MAC. Features.md notes MAC is burned into hardware while IPs
> change - true, but MAC is also trivially spoofable and a docked laptop reports three of them. It
> is reported as an attribute; `MachineGuid` is the key the backend uniques on.

---

## IPC - `Ipc/`

### `IpcChannel` - `Ipc/IpcChannel.cs`

Static class. Length-prefixed framing over a pipe stream.

Byte mode with an explicit 4-byte **big-endian** length rather than
`PipeTransmissionMode.Message`: message mode silently truncates anything larger than the read
buffer, and a policy document with a long category list can exceed a small buffer. An explicit
length turns an oversized frame into a hard error instead of a corrupted one.

| Member                                                     | Description                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MaxFrameBytes` (private const)                            | 4 MB. Nothing legitimate approaches it - screenshots travel as paths, not bytes - so it exists purely to bound a malformed or hostile length prefix.                                  |
| `WriteMessageAsync(Stream, IpcMessage, CancellationToken)` | Serializes polymorphically as `IpcMessage`, writes header + payload, flushes. Throws `InvalidOperationException` if the payload exceeds the cap.                                      |
| `ReadMessageAsync(Stream, CancellationToken)`              | Reads one frame. Returns `null` when the peer closed the pipe cleanly. Throws `InvalidDataException` for an out-of-range length and `EndOfStreamException` on a mid-frame disconnect. |
| `ReadExactlyAsync` (private)                               | Loops until the buffer is full; returns `false` on a clean zero-byte read.                                                                                                            |

### `IpcMessages.cs`

`IpcMessage` is an abstract record serialized polymorphically on a `$type` discriminator, so a
version mismatch between the two executables surfaces as an unknown-type failure rather than a
silently misparsed payload.

**Host -> Service**

| Message                        | Payload                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `HelloMessage` (`hello`)       | `UserSid`, `UserName`, `WindowsSessionId`, `HostVersion`. First message on every connection.                        |
| `SubmitAttendanceMessage`      | `AttendanceEvent`                                                                                                   |
| `SubmitActivityMetricMessage`  | `ActivityMetricEvent`                                                                                               |
| `SubmitActivitySessionMessage` | `ActivitySessionEvent`                                                                                              |
| `SubmitBrowserActivityMessage` | `BrowserActivityEvent`                                                                                              |
| `SubmitAlertMessage`           | `AlertEvent`                                                                                                        |
| `SubmitScreenshotMessage`      | `ClientEventId`, `UserSid`, `CapturedAt`, `FilePath`, `SizeBytes`, `Width?`, `Height?` - **path only**, never bytes |
| `ConsentAcknowledgedMessage`   | `UserSid`, `PolicyVersion`, `AcknowledgedAt`                                                                        |

**Service -> Host**

| Message                    | Payload                                         |
| -------------------------- | ----------------------------------------------- |
| `HelloAckMessage`          | `Policy`, `ConsentRequired`, `BackendReachable` |
| `PolicyUpdatedMessage`     | `Policy`, `ConsentRequired`                     |
| `ShowNotificationMessage`  | `Title`, `Message`, `Severity`                  |
| `RequestScreenshotMessage` | (no payload) - on-demand capture                |
| `ShutdownMessage`          | `Reason?`                                       |

**Either direction:** `PingMessage` (`SentAt`, defaults to now). The service echoes a fresh one.

---

## Policy - `Policy/`

### `AgentPolicy` - `Policy/AgentPolicy.cs`

Sealed record mirroring the backend's `AgentPolicyDto`. Always the full document, never a diff.
Every property has a default matching Features.md, because those defaults are what the agent runs
on before its first successful fetch - collection must start immediately rather than block on the
network.

| Property         | Type                   | Default                                                                                     |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `Version`        | `int`                  | `1` - incremented by the backend on every write; a change re-prompts for consent            |
| `Attendance`     | `AttendancePolicy`     | `Enabled = true`                                                                            |
| `Activity`       | `ActivityPolicy`       | `Enabled = true`, `IdleThresholdSeconds = 300`                                              |
| `AppSession`     | `AppSessionPolicy`     | `Enabled = true`, `PollSeconds = 1`                                                         |
| `BrowserMonitor` | `BrowserMonitorPolicy` | `Enabled = true`, `UiaTimeoutMs = 500`, `MaxRetryAttempts = 3`, `UrlRefreshSeconds = 10`    |
| `Screenshot`     | `ScreenshotPolicy`     | `Enabled = true` (testing; off before publish), `IntervalSeconds = 600`, `JpegQuality = 70` |
| `Usb`            | `UsbPolicy`            | `Enabled = true`, `ReconciliationIntervalSeconds = 5`, `AlertOnInsertion = false`           |
| `Alert`          | `AlertPolicy`          | `Enabled = true`, `BlacklistEnabled = true`, `NotifyOutsideWorkingHours = false`            |
| `Alert.Idle`     | `IdleAlertPolicy`      | `Enabled = true`, `Normal = 1800s`, `Moderate = 2700s`, `Severe = 3600s`, `Renotify = 900s` |
| `Sync`           | `SyncPolicy`           | `BatchIntervalSeconds = 120`, `MaxBatchSize = 500`, backoff `5`-`120s`                      |
| `Retention`      | `RetentionPolicy`      | `RetentionDays = 90`, `UndeliveredRetentionDays = 30`                                       |
| `WorkingHours`   | `WorkingHoursPolicy`   | `08:00`-`17:00`, Monday-Friday                                                              |
| `Categories`     | `List<CategoryRule>`   | empty                                                                                       |

**`CategoryRule`**: `Pattern` (required), `Target` (required), `Tag` (default `Neutral`),
`IsBlacklisted`. Flattened from the backend's categories table so the agent can warn locally
without a round trip.

### `PolicyEvaluator` - `Policy/PolicyEvaluator.cs`

Static class applying category rules locally. The backend re-derives the same tags at ingest and
its answer wins for reporting; this exists so the desktop notification is immediate.

| Method                                                          | Behaviour                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MatchApplication(rules, appName, processName, executablePath)` | Case-insensitive **contains** match against all three candidates, so one rule of `"chrome"` catches every spelling. A blacklist match returns immediately and wins outright - it cannot be overridden by a later `Productive` rule for the same app. Otherwise returns the first match. |
| `MatchDomain(rules, domain)`                                    | **Suffix** match: `facebook.com` covers `m.facebook.com` but not `notfacebook.com` (the check is exact equality or `EndsWith("." + pattern)`). Same blacklist-wins rule. Returns `null` for a blank domain.                                                                             |
| `TagFor(rule)`                                                  | `null` -> `Neutral`; blacklisted -> `Blacklisted`; otherwise the rule's own tag.                                                                                                                                                                                                        |
| `IsWithinWorkingHours(policy, localTime)`                       | Checks the day name against `WorkingDays`, then the time against `StartLocal`/`EndLocal` (falling back to 08:00/17:00 if unparseable). **An end earlier than the start is treated as a shift crossing midnight** (e.g. 22:00-06:00). Used to suppress out-of-hours desktop alerts.      |

---

## Storage - `Storage/`

### `LocalStoreSchema` - `Storage/LocalStoreSchema.cs`

Internal static class holding `Version` (currently `2`), the entire schema as one `Sql` string
executed as a batch, and `Migrations` - the ordered upgrade steps for a database created by an
earlier agent.

`Sql` is what a database created **today** looks like, and every statement in it is
`IF NOT EXISTS`, so running it against an existing file adds what is missing and touches nothing
else. What it cannot do is change a table that already exists: SQLite matches
`CREATE TABLE IF NOT EXISTS` **by name, not by shape**, so a column added there is invisible to
every agent installed before it. `Migrations` is the other half - each entry is the version it
produces plus the statements that get there, applied once and tracked in `schema_info`. Adding a
column means editing both and bumping `Version`. A shipped migration is **never rewritten**: a
workstation that has already run it will not run it again.

| Version | Change                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | Initial schema                                                                                                                                                                                                        |
| 2       | `attendance_sessions.revision` - the per-session snapshot counter the server orders reports by. Existing rows start at `0`, matching the server default, so the first refresh after the upgrade lands as revision `1` |

Pragmas: `journal_mode = WAL` (so the sync worker reads pending rows while collectors write new
ones without either blocking), `synchronous = NORMAL`, `foreign_keys = ON`.

**Telemetry tables** - `attendance_sessions`, `activity_metrics`, `activity_sessions`,
`browser_activity`, `usb_events`, `alerts`, `screenshots`. Each carries its **own**
`created_utc` / `sent_utc` / `attempts` columns rather than sharing a sync-state side table, so
sync is a partial-indexed scan per table with no join, and "delete only after successful
synchronization" is a plain `DELETE` on acknowledged ids. Each has a partial index
`WHERE sent_utc IS NULL`; `alerts` additionally indexes `(user_sid, type, resolved_at)` for open
incidents.

The `screenshots` table stores **metadata plus a `file_path`** - the image is a file on disk, so
the database stays small and a failed upload retries from the original bytes.

**Policy tables** - `policy_cache` (single row, `CHECK (id = 1)`, ~32 typed columns),
`policy_working_days` and `policy_categories` (scalar list members as rows, not delimited
strings).

**`consent_records`** - `(user_sid, policy_version)` primary key, with `sent_utc`/`attempts` so
acknowledgements queue for upload like any other event.

`schema_info` records applied versions.

### `LocalStore` - `Storage/LocalStore.cs`

Sealed class. The database itself: connection management, schema initialization, the policy cache
and consent records.

Concurrency model: a short-lived connection **per operation**, pooled by Microsoft.Data.Sqlite.
Combined with WAL, readers and writers do not block each other.

| Member                                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LocalStore(ILogger<LocalStore>, string? databasePath = null)` | Calls `AgentPaths.EnsureCreated()` and builds the connection string (`ReadWriteCreate`, shared cache, pooling). The optional path override exists for tests.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Open()` (internal)                                            | Opens and returns a new pooled connection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Initialize()`                                                 | Brings the database up to `LocalStoreSchema.Version`. Decides **before creating anything** whether this is a first run (no `schema_info` table): a fresh file gets `Sql` and is stamped at the current version, an existing one gets only the migrations above its stored version, one transaction each. Deciding afterwards would re-run v2's `ALTER TABLE` against a table just created with the column, which SQLite rejects - every new install would fail to start. Called eagerly at service startup so a schema failure surfaces there rather than on the first collector message. |
| `SavePolicy(AgentPolicy)`                                      | Upserts the single `policy_cache` row and replaces the working-day and category rows - **all in one transaction**, so a crash mid-write can never leave the agent running half of one policy version and half of another.                                                                                                                                                                                                                                                                                                                                                                 |
| `ReplaceWorkingDays` / `ReplaceCategories` (private static)    | Delete-then-insert helpers, executed inside the caller's transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `LoadPolicy()`                                                 | Rehydrates the full `AgentPolicy`, including working days and categories. Returns `null` if the agent has never fetched one - callers then fall back to `new AgentPolicy()`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `RecordConsent(userSid, policyVersion, acknowledgedAt)`        | `INSERT OR IGNORE` - re-acknowledging the same version is a no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `HasConsented(userSid, policyVersion)`                         | Used by `IpcServer` to decide whether the host must prompt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**`SqlTime`** (internal static): timestamp conversion for the store. `Now()`, `From()`,
`FromNullable()`, `Parse()`, `ParseNullable()` - everything is ISO-8601 UTC round-trip text
(`"o"`), which sorts lexicographically in chronological order and is immune to the workstation's
timezone changing between write and read.

### `TelemetryQueue` - `Storage/TelemetryQueue.cs`

Sealed class over `LocalStore`. The offline queue: collectors enqueue, the sync worker drains.

A row's `sent_utc` is `NULL` while pending. Acknowledged rows are **marked**, not deleted inline,
and swept later - so an acknowledgement that races a crash cannot lose an event that was never
actually stored server-side.

**Enqueue.** Six `Enqueue(...)` overloads plus `EnqueueScreenshot`. Two use upsert-and-requeue
semantics; the rest are insert-once:

| Method                                                                           | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Enqueue(AttendanceEvent)`                                                       | Upsert on `session_id`, **resetting `sent_utc` to NULL and `attempts` to 0**, so each refresh of an open session's running totals reaches the server. The conflict clause carries `WHERE attendance_sessions.logout_time IS NULL`: **a stamped logout is final**, and a write arriving after it is dropped rather than merged. This is the layer where getting it wrong is unrecoverable - a null logout time means "still open", and one landing on a closed row blanked a logout that had already been reported. **Every write bumps `revision`** (1 on insert, `revision + 1` on conflict), which is the number the server orders these reports by. Assigned here because this statement is the only place that knows whether a write created the row or rewrote it, and because a counter held by the collectors would restart at 1 whenever the host process did. |
| `Enqueue(AlertEvent)`                                                            | Upsert on `client_event_id`, also requeuing. An escalating incident reuses one id and each escalation must reach the server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Enqueue(ActivityMetricEvent)`                                                   | `INSERT OR IGNORE` on `client_event_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Enqueue(ActivitySessionEvent)`                                                  | `INSERT OR IGNORE` on `activity_session_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Enqueue(BrowserActivityEvent)`                                                  | `INSERT OR IGNORE` on `browser_activity_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Enqueue(UsbEvent)`                                                              | `INSERT OR IGNORE` on `client_event_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EnqueueScreenshot(id, userSid, capturedAt, filePath, sizeBytes, width, height)` | `INSERT OR IGNORE` on `client_event_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**Dequeue.** `DequeueAttendance`, `DequeueActivityMetrics`, `DequeueActivitySessions`,
`DequeueBrowserActivity`, `DequeueUsbEvents`, `DequeueAlerts`, `DequeueScreenshots`,
`DequeueConsents` - each takes a `max` and returns pending rows ordered by `created_utc`
(consents by `acknowledged_at`). Two projection records support the non-event queues:

- `PendingScreenshot(ClientEventId, UserSid, CapturedAt, FilePath, Width, Height)`
- `PendingConsent(UserSid, PolicyVersion, AcknowledgedAt)`

**Acknowledgement and bookkeeping.**

| Method                                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MarkSent(channel, clientEventIds)`        | Stamps `sent_utc` for each acknowledged immutable-event id, in one transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MarkAttendanceSent(sentEvents, acknowledgedClientEventIds)` | Stamps `sent_utc` only when the acknowledged attendance row still has the exact `Revision` that was uploaded. A final logout written while an older open snapshot is in flight therefore remains pending and cannot be removed by retention. |
| `MarkScreenshotSent(clientEventId)`        | Same, for the screenshot spool.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MarkConsentSent(userSid, policyVersion)`  | Same, for consent records.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `RecordRejection(channel, clientEventIds)` | Increments `attempts` on **exactly the ids the server refused**. Only rejections count - never a transient network or 5xx failure - because `attempts` is what eventually causes `DropExhausted` to discard a row, and counting an unreachable server would age out perfectly good data during an outage, the precise opposite of what the offline queue exists for. Scoped to the failed ids rather than every pending row, so one malformed event cannot push a whole channel toward being dropped.                                                                                                                                                                                                                                                                                                                                                                                      |
| `DropExhausted(maxAttempts)`               | Deletes pending rows whose `attempts` has reached the limit, across every channel, in one transaction. Returns the count per channel so the caller can log what was lost - **losing data is the point here, so it must never happen quietly.** Without this, an event the server will never accept is resent every sync cycle until the retention window expires weeks later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PendingCount(channel)`                    | Count of unsent rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Purge(undeliveredRetentionDays)`          | Deletes rows that are either already sent **or** older than the cutoff, across all seven telemetry tables plus sent consent records, in one transaction. **Returns the screenshot file paths that were dropped** so the caller can delete them from disk. **`attendance_sessions` is the exception**: an acknowledged row is deleted only once its session has _closed_. Every other table holds finished observations, so delivery ends the row's life; an attendance row is the live state of a session still running - acknowledged and then rewritten, over and over. Deleting it at the first acknowledgement would restart the session on the next refresh as a fresh row at revision 1, which the server reads as older than what it holds and discards, and would also lose the row `RecoverOpenAttendanceSessions` reads. The age clause still applies, as a disk-space backstop. |
| `RecoverOpenAttendanceSessions()`          | During each service maintenance cycle, closes rows abandoned by a power loss, a killed host or an upgrade, stamping `end_reason = 'Recovered'`, bumping `revision` and requeuing them. Without it the day's attendance would stay open forever. Returns the row count and logs a warning when non-zero. **Two rules, both of which this got wrong before** - see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Recovery has to answer two questions, and the obvious answer is wrong to both.**

_What logout time?_ The last instant the agent actually observed, reconstructed as
`login_time + (total_active_seconds + total_idle_seconds)`. Those totals are refreshed every 30
seconds, so they are exactly how far the session had got when it was last persisted; the result is
accurate to that heartbeat interval. Time after the last durable heartbeat is deliberately
excluded because it was not observed. It used to be stamped at `login_time`, which reported a session
carrying a quarter of an hour of recorded work as having ended the instant it began - a
zero-length working day, on precisely the rows where the real answer was already sitting in the
adjacent columns.

_Which rows?_ Only sessions that are actually over. **Every open row has a `NULL` logout time,
including the session running right now** - the host sends `NULL` on every periodic flush and
fills it in only at the end. Closing all of them at startup stamped a logout on the live session
while the employee was still at their desk. A row now counts as abandoned only once it has gone
`AgentCadence.AttendanceStale` without being refreshed, which a live host cannot do.

The two constants are in `AgentCadence` rather than beside the code that uses them, because the
staleness window is a contract between the processes: the host writes on `AttendanceFlush`, and
the service concludes a host is gone from how long it has been since the last write. Declaring
them separately would let them drift, and the resulting failure is silent - the service would just
start reaching the wrong conclusion.

`TableName(channel)` and `KeyColumn(channel)` are private closed switches. They are the only
source of the interpolated identifiers in `MarkSent`, `RecordFailure`, `PendingCount` and
`Purge` - never caller input - so the interpolation cannot carry injected SQL. Every value is a
bound parameter.

`Query<T>(sql, max, map)` is the shared read helper. `ParseNullableEnum<TEnum>` and
`ParseNullableGuid` handle nullable columns. **`SqliteReaderExtensions`** (internal static) adds
`GetNullableString(column)` and `GetNullableInt32(column)`.

---

## Logging - `Logging/FileLoggerProvider.cs`

Rolling-file `ILoggerProvider` used by both executables. Hand-rolled rather than pulling in a
logging framework: the agent publishes self-contained to 30 workstations and this is the only sink
it needs beyond the Event Log.

The hard rule throughout: **logging must never take the agent down.** A full disk, a revoked ACL,
or a file deleted underneath the writer all end in a dropped line and a retry on the next write.

### `FileLogOptions`

| Property           | Default                   | Description                                                                                                                                                                                                                          |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FileNamePrefix`   | _required_                | Leading file-name component. Must differ per writing process (`service`, `host-s<session>`) so two processes never share a handle and interleave half-written lines. Also the prune glob, so a process only deletes its own history. |
| `Directory`        | `AgentPaths.LogDirectory` | Target directory. Created lazily on first write.                                                                                                                                                                                     |
| `MinimumLevel`     | `Information`             | Cheap first gate applied before the message is formatted. Standard `Logging:LogLevel` filters still apply on top.                                                                                                                    |
| `MaxFileBytes`     | 8 MB                      | Size roll threshold.                                                                                                                                                                                                                 |
| `RetainedFileDays` | 14                        | Best-effort age cutoff, applied on each file open.                                                                                                                                                                                   |

### `FileLogWriter` (internal)

Owns the single file handle behind a lock.

- **Daily roll** by comparing `DateOnly.FromDateTime(DateTime.Now)` - local date, not UTC, so an
  administrator can correlate lines with the workstation clock and the Event Log.
- **Size roll** to `{prefix}-{date}.1.log`, `.2.log`, ... On open it skips forward past any segment
  already at the cap, so a mid-day restart does not append past the limit.
- Opens with `FileMode.Append` / `FileShare.ReadWrite`, so an administrator can tail the file
  while the agent holds it.
- `AutoFlush = true`: the interesting lines are the ones written just before a crash, and agent log
  volume makes the syscall cost irrelevant.
- `Prune()` deletes matching files older than the cutoff, swallowing failures - the host may lack
  delete rights, and `RetentionWorker` is the SYSTEM-side backstop.

### `FileLogger` (internal)

One per category, all sharing the provider's writer. Line format:

```
2026-08-10 18:02:03.462 +06:00 [INF] Category(EventId) => Scope: message
<exception, if any, on following lines>
```

Levels are fixed-width (`TRC`/`DBG`/`INF`/`WRN`/`ERR`/`CRT`) so the file stays column-aligned and
greppable. `BeginScope` delegates to the external scope provider; scopes are rendered inline.

### `FileLoggerProvider`

`[ProviderAlias("File")]`, implements `ILoggerProvider` and `ISupportExternalScope`. Caches loggers
per category in a `ConcurrentDictionary`. `Dispose()` clears the cache and disposes the writer.

### `FileLoggerBuilderExtensions`

| Method                                                  | Description                                                                                                                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AddAgentFileLog(this ILoggingBuilder, FileLogOptions)` | Registers the provider. Both executables call this.                                                                                                                                                                   |
| `CreateStandalone(FileLogOptions)`                      | Builds a provider directly, for code running before (or instead of) a host - specifically the service's configuration-load failure path, where the log file is the only evidence of why the service refused to start. |

---

## Related

- [architecture.md](architecture.md) - process model, data flow and invariants
- [agent-core.md](agent-core.md) / [agent-service.md](agent-service.md) / [agent-host.md](agent-host.md)
- [../reference/configuration.md](../reference/configuration.md) - policy fields this reads
- [../operations/diagnostics.md](../operations/diagnostics.md) - logs and tracing
