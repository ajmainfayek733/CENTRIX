# Backend API Specification — Workforce Agent

**Audience:** a backend developer who has not seen the Agent's source code, implementing the server in any stack.
**Status:** the Agent client is fully built against this contract via an `IBackendClient` abstraction. No backend exists yet — this document _is_ the spec the backend must satisfy for the client to work correctly on the first try.

---

## 1. Overview

### 1.1 Purpose

The Agent is a Windows client installed on company-owned workstations that collects workplace productivity telemetry (attendance, application usage, active/idle time, browser navigation, screenshots, USB device activity) and enterprise security alerts, under full employee disclosure. This backend receives that telemetry, stores it, serves admin-controlled policy back to each device, and (out of scope for this spec) presumably powers a reporting dashboard.

### 1.2 High-level data flow

```
                         +------------------------+
                         |   Windows Workstation   |
                         |  ------------------      |
                         |  Agent.Host (service)    |
                         |  Agent.TrayHelper (user) |
                         |        |                 |
                         |   Local SQLite outbox     |
                         |   (encrypted at rest)     |
                         +-----------+--------------+
                                     |
                     HTTPS (TLS 1.2+), bearer-token auth
                                     |
              -----------------------------------------------
              |                     |                        |
     POST /api/v1/events/{ch}  GET /api/v1/policy   POST /api/v1/screenshots
              |                     |                        |
              v                     v                        v
     +------------------+  +----------------+       +-------------------+
     |  Event ingestion  |  | Policy service |       | Screenshot storage |
     |  (per-channel)    |  | (per-org, per- |       | (blob store, e.g.  |
     |                   |  |  device policy)|       |  S3/Azure Blob)    |
     +--------+----------+  +----------------+       +---------+---------+
              |                                                |
              v                                                v
     +------------------------------------------------------------+
     |                     Backend datastore                       |
     |  (event tables, alerts, consent records, screenshot index)  |
     +------------------------------------------------------------+
```

Each device runs two cooperating processes (a Windows Service and a per-user tray helper — an internal client-side detail, irrelevant to this API beyond explaining why events for one `MachineId` may arrive tagged with different `UserSid` values as users log on/off). Both talk to the backend through the same three endpoint families described below.

### 1.3 What the Agent does _not_ do

Per organizational policy, the Agent never captures keystroke content, personal account contents, or provides remote control. It also never sends data until the employee has acknowledged the on-device consent notice (see §8). The backend should treat any payload arriving without a corresponding consent record as a data-handling exception, not silently accept it.

---

## 2. Authentication & Security

### 2.1 Transport

- TLS 1.2 or higher on every endpoint. The Agent's HTTP client is built against a base URL (`https://.../`) with no support for plaintext HTTP.

### 2.2 Device authentication (open decision — see §9.1)

The Agent's `IBackendClient` sends requests via a standard `HttpClient` with a bearer token expected in the default `Authorization` header, configured at startup. **The concrete token-issuance flow is not yet decided** — the client is ready for either of:

- **API key per device**: issued once at enrollment (e.g., during Intune/GPO deployment), stored via Windows DPAPI on the device (the same mechanism the Agent already uses to protect its local database key), sent as `Authorization: Bearer <device-api-key>`.
- **Short-lived JWT per device**, obtained via a `POST /api/v1/auth/token` exchange (device API key or client certificate → JWT), refreshed before expiry.

Recommendation: JWT with a device-bound refresh credential, since it supports token revocation per-device without invalidating a shared secret — but this is the backend developer's call; flagged in §9.1 as needing a decision before go-live.

### 2.3 Token rotation

Whatever scheme is chosen, the Agent will retry a `401 Unauthorized` response by attempting to re-authenticate once before treating the sync cycle as failed (this retry behavior belongs in the client, not yet implemented — see §9.1). The backend should return `401` (not `403`) for expired/invalid credentials, and `403` only for a validly-authenticated device that's been deliberately deactivated.

---

## 3. Sync Strategy the Backend Must Support

### 3.1 Batch frequency and size

| Priority                                                                | Default interval                          | Trigger                                         |
| ----------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------- |
| Batched (Attendance, App Session, Activity Session, Browser Navigation) | 2 minutes (admin-configurable via policy) | Timer tick                                      |
| Immediate (Alerts, USB device events)                                   | Checked every 5 seconds                   | Timer tick, but only pushes if rows are pending |
| Screenshots                                                             | Same interval as Batched                  | Timer tick                                      |

Default max batch size is 500 events per channel per push (admin-configurable). The backend should accept batches up to at least this size without rejecting them; if you enforce a smaller server-side limit, return a `413`-style error with a body the Agent can log (it does not currently auto-split oversized batches).

### 3.2 Idempotency (critical)

Every event carries a client-generated `clientEventId` (a GUID) that **never changes across retries**. If a batch push fails partway (network drop after the backend persisted some rows but before the client received the acknowledgment), the Agent will resend the _entire_ unacknowledged batch on the next cycle, including rows the backend may have already stored.

**The backend must deduplicate on `clientEventId` per channel** (e.g., a unique constraint on `(channel, client_event_id)`), and the push response must report back only the IDs it can now confirm are durably stored — including ones that turn out to be duplicates of already-stored rows. The Agent deletes an event from its local queue as soon as its ID appears in `acknowledgedEventIds`; anything not acknowledged is retried automatically (with exponential backoff, capped between 5 seconds and 2 minutes by default) — the backend does not need to manage retry logic itself.

### 3.3 Acknowledgment contract

A push is either fully processed or the backend returns a non-2xx status (the Agent does not currently support partial-batch semantics like "207 Multi-Status" — treat the whole batch atomically: either persist everything and return all IDs in `acknowledgedEventIds`, or persist nothing and return a non-2xx so the whole batch retries). If you want partial-success semantics in a future version, that's a coordinated client+server change, not something to add unilaterally on the backend.

### 3.4 Data the Agent purges locally — the backend is the system of record after ack

Once acknowledged, the Agent deletes its local copy immediately. If a device is offline for more than 30 days (admin-configurable), it purges unsynced data and logs that as a local data-loss event — there is no other resend mechanism, so once a batch is gone, it's gone. Backend retention/backup planning should account for the fact that the Agent is _not_ a durable backing store beyond that window.

---

## 4. Endpoint-by-Endpoint Contract

All endpoints are versioned under `/api/v1/`. All timestamps are UTC, ISO 8601 (`.NET "O"` round-trip format, e.g. `2026-07-27T14:32:05.1234567+00:00`).

### 4.1 `POST /api/v1/events/{channel}` — generic telemetry ingestion

One endpoint shape serves six channels; `{channel}` is one of: `attendance`, `app-session`, `activity-session`, `browser-navigation`, `usb-device`, `alert`.

**Request:**

```json
{
  "events": [
    {
      "clientEventId": "5b6e...-guid",
      "payloadJson": "{...channel-specific JSON, see 4.1.1-4.1.6...}"
    }
  ]
}
```

`payloadJson` is a JSON string (double-encoded) containing the full channel-specific event object described below — the Agent serializes its internal C# record directly, so the field names are exactly as documented per channel.

**Response (success):**

```json
{ "acknowledgedEventIds": ["5b6e...-guid", "..."] }
```

HTTP `200 OK`.

**Response (failure):** any non-2xx status. Body is not parsed by the client beyond logging; a `{"error": "..."}` body is recommended for your own observability but not required by the Agent.

**Sample request** (`channel = attendance`):

```json
POST /api/v1/events/attendance
{
  "events": [
    {
      "clientEventId": "8f14e45f-ceea-4d5a-9e57-5a5b7f2b1a3c",
      "payloadJson": "{\"ClientEventId\":\"8f14e45f-ceea-4d5a-9e57-5a5b7f2b1a3c\",\"MachineId\":\"4c4c4544-0044-3010-8035-b9c04f435931\",\"UserSid\":\"S-1-5-21-1111111111-2222222222-3333333333-1001\",\"SessionId\":1,\"IsRemoteSession\":false,\"Reason\":null,\"OccurredAtUtc\":\"2026-07-27T09:00:00.0000000+00:00\",\"EventType\":\"Login\"}"
    }
  ]
}
```

**Sample response:**

```json
{ "acknowledgedEventIds": ["8f14e45f-ceea-4d5a-9e57-5a5b7f2b1a3c"] }
```

#### 4.1.1 Channel `attendance` — Attendance module

| Field           | Type           | Required | Notes                                                                                 |
| --------------- | -------------- | -------- | ------------------------------------------------------------------------------------- |
| ClientEventId   | GUID           | yes      | idempotency key                                                                       |
| MachineId       | string         | yes      | see §5.1                                                                              |
| UserSid         | string         | yes      | Windows SID, see §5.1                                                                 |
| SessionId       | int            | yes      | Windows logon session ID (not stable across reboots)                                  |
| IsRemoteSession | bool           | yes      | true if RDP                                                                           |
| EventType       | string enum    | yes      | `Login`, `Logout`, `Lock`, `Unlock`, `SleepStart`, `SleepEnd`, `IdleStart`, `IdleEnd` |
| OccurredAtUtc   | ISO 8601       | yes      |                                                                                       |
| Reason          | string \| null | no       | set only for synthetic events, e.g. `"ServiceRestartRecovery"` — see §7               |

Backend derivation note: the Agent sends raw state-transition events, not computed "hours worked." Daily attendance summaries (logged-in time minus merged idle/lock/sleep intervals) must be computed backend-side (or reused from the client's own algorithm, described in the module's design notes) if your dashboard needs a single "hours worked today" number. Session boundaries split at **UTC midnight**, not local midnight.

#### 4.1.2 Channel `app-session` — Active App Session module

| Field            | Type           | Required | Notes                                                                        |
| ---------------- | -------------- | -------- | ---------------------------------------------------------------------------- |
| ClientEventId    | GUID           | yes      |                                                                              |
| MachineId        | string         | yes      |                                                                              |
| UserSid          | string         | yes      |                                                                              |
| WindowsSessionId | int            | yes      |                                                                              |
| Kind             | string enum    | yes      | `Application`, `Desktop`, `Locked`, `Idle`, `Sleeping`, `Disconnected`       |
| ProcessId        | int            | yes      | 0 for non-`Application` kinds                                                |
| Executable       | string         | yes      | full path, or empty for pseudo-states                                        |
| WindowTitle      | string         | yes      |                                                                              |
| StartTimeUtc     | ISO 8601       | yes      |                                                                              |
| EndTimeUtc       | ISO 8601       | yes      | only sent once the session is closed — the Agent never syncs an open session |
| ProductivityTag  | string \| null | no       | see §5.4                                                                     |

#### 4.1.3 Channel `activity-session` — Active vs Idle module

| Field                    | Type        | Required | Notes                                                                                               |
| ------------------------ | ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| ClientEventId            | GUID        | yes      |                                                                                                     |
| MachineId, UserSid       | string      | yes      |                                                                                                     |
| State                    | string enum | yes      | `Active`, `Idle`, `Locked`, `Sleeping`, `Offline`                                                   |
| Reason                   | string enum | yes      | `None`, `NoInput`, `Meeting`, `Presentation`, `CpuBusy`, `SuspiciousActivity`, `PossibleAutomation` |
| StartTimeUtc, EndTimeUtc | ISO 8601    | yes      |                                                                                                     |

#### 4.1.4 Channel `browser-navigation` — Browser Monitor module

| Field              | Type           | Required | Notes                                                                                                                   |
| ------------------ | -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| ClientEventId      | GUID           | yes      |                                                                                                                         |
| MachineId, UserSid | string         | yes      |                                                                                                                         |
| Browser            | string enum    | yes      | `Unknown`, `Chrome`, `Edge`, `Brave`, `Opera`, `Firefox`                                                                |
| RawUrl             | string         | yes      | exactly what was read from the address bar                                                                              |
| NormalizedUrl      | string \| null | no       | scheme/host lowercased, default ports stripped, IDN hosts converted to Punycode                                         |
| Domain             | string \| null | no       | leading `www.` stripped; use this for blacklist-style reporting                                                         |
| Category           | string enum    | yes      | `Https`, `Http`, `InternalBrowserPage`, `File`, `Ftp`, `Data`, `Mailto`, `JavaScript`, `AboutBlank`, `Other`, `Invalid` |
| OccurredAtUtc      | ISO 8601       | yes      |                                                                                                                         |

Privacy note for dashboard builders: `RawUrl`/`NormalizedUrl` can include query strings, which may contain search terms or session tokens. This is disclosed to employees (see the Terms of Service / Privacy Policy documents), but consider redacting query strings in any UI that isn't strictly needed for policy enforcement.

#### 4.1.5 Channel `usb-device` — USB Logs module

| Field                             | Type           | Required | Notes                                                                                                                                   |
| --------------------------------- | -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ClientEventId                     | GUID           | yes      |                                                                                                                                         |
| MachineId                         | string         | yes      |                                                                                                                                         |
| UserSid                           | string         | yes      | the active console user at the time of the event — USB devices belong to the machine, not a session, so this is best-effort attribution |
| PnpDeviceId                       | string         | yes      | **the stable device identity** — use this, not SerialNumber, as the dedup/correlation key (see rationale in §5.3)                       |
| SerialNumber, Model, Manufacturer | string \| null | no       |                                                                                                                                         |
| CapacityBytes                     | long \| null   | no       |                                                                                                                                         |
| Volumes                           | array          | yes      | `[{ "DriveLetter": "E:", "VolumeLabel": "MyDrive", "FileSystem": "FAT32" }, ...]` — may be empty (device present, not yet mounted)      |
| EventType                         | string enum    | yes      | `Inserted`, `MetadataChanged`, `Removed`                                                                                                |
| OccurredAtUtc                     | ISO 8601       | yes      |                                                                                                                                         |

A "session" (one physical insert-to-remove lifecycle) is the sequence of events sharing the same `PnpDeviceId` between an `Inserted` and the next `Removed` for that ID.

#### 4.1.6 Channel `alert` — Alerts module

| Field                                               | Type             | Required | Notes                                                                                                                                                                                                               |
| --------------------------------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClientEventId                                       | GUID             | yes      | this is the Alert ID                                                                                                                                                                                                |
| MachineId, UserSid                                  | string           | yes      |                                                                                                                                                                                                                     |
| Type                                                | string enum      | yes      | `IdleWarning`, `ExcessiveIdle`, `BlacklistedWebsite`, `RestrictedApplication`, `OutsideWorkingHours`, `ScreenshotFailure`, `UsbViolation`, `ServiceFailure`, `SyncFailure`, `PolicyViolation`, `SuspiciousActivity` |
| Severity                                            | string enum      | yes      | `Information`, `Warning`, `High`, `Critical`                                                                                                                                                                        |
| State                                               | string enum      | yes      | `New`, `Shown`, `Acknowledged`, `Resolved`, `Archived`                                                                                                                                                              |
| Title, Message                                      | string           | yes      |                                                                                                                                                                                                                     |
| ContextJson                                         | string           | yes      | JSON-encoded string with type-specific detail, e.g. `{"IdleSeconds":1250,"ThresholdSeconds":300}` for idle alerts, or `{"Domain":"facebook.com","FullUrl":"...","Browser":"Chrome"}` for blacklist alerts           |
| TriggeredAtUtc                                      | ISO 8601         | yes      |                                                                                                                                                                                                                     |
| AcknowledgedAtUtc, ResolvedAtUtc, LastNotifiedAtUtc | ISO 8601 \| null | no       |                                                                                                                                                                                                                     |
| EscalationLevel                                     | int              | yes      | increments each time the same open alert re-fires at a higher severity (e.g. idle Warning→High→Critical is one alert, escalation levels 1→2→3)                                                                      |
| NotificationCount                                   | int              | yes      | how many times this alert has actually been shown to the employee                                                                                                                                                   |

**Important:** the same `ClientEventId` for an alert is reused across escalations (it's the same underlying incident being updated, not a new event each time) — the backend should `UPSERT` on `ClientEventId` for this channel specifically, rather than treating every push as an insert-only append like the other channels.

### 4.2 `GET /api/v1/policy` — policy distribution

**Purpose:** the Agent polls this every 2 minutes (independent of the sync batch cycle) to pick up admin-configured changes without a restart.

**Request:** no body. The device's identity comes from the auth token (§2).

**Response (`200 OK`):** the full `PolicyDocument`, always returned in full (not a diff):

```json
{
  "Version": 4,
  "Attendance": { "Enabled": true, "IdleThreshold": "00:05:00" },
  "Activity": {
    "Enabled": true,
    "IdleThreshold": "00:05:00",
    "MeetingDetectionEnabled": true,
    "MeetingOrPresentationFlagAfter": "00:40:00",
    "MeetingProcessNames": ["Teams", "Zoom", "slack", "GoogleMeet", "lync"],
    "PresentationProcessNames": ["POWERPNT", "wpp"],
    "CpuBusyThresholdPercent": 50.0
  },
  "AppSession": { "Enabled": true, "PollInterval": "00:00:01" },
  "BrowserMonitor": { "Enabled": true, "UiaTimeout": "00:00:00.500", "MaxRetryAttempts": 3 },
  "Screenshot": { "Enabled": false, "CaptureInterval": "00:10:00", "JpegQuality": 70 },
  "Usb": {
    "Enabled": true,
    "ReconciliationInterval": "00:00:05",
    "EventCorrelationWindow": "00:00:03",
    "AlertOnInsertion": false
  },
  "Alert": {
    "Enabled": true,
    "Idle": {
      "Enabled": true,
      "WarningAfter": "01:00:00",
      "HighAfter": "01:10:00",
      "CriticalAfter": "01:20:00",
      "NotifyManagerAfter": "01:30:00",
      "RenotifyInterval": "00:15:00"
    },
    "Blacklist": { "Enabled": false, "Categories": [], "DomainPatterns": [] },
    "NotifyOutsideWorkingHours": false
  },
  "Sync": {
    "BatchInterval": "00:02:00",
    "MaxBatchSize": 500,
    "MinRetryBackoff": "00:00:05",
    "MaxRetryBackoff": "00:02:00"
  },
  "Retention": { "UndeliveredRetentionDays": 30 },
  "WorkingHours": {
    "StartLocal": "08:00:00",
    "EndLocal": "17:00:00",
    "WorkingDays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
  },
  "ProductivityTags": {
    "chrome.exe": "Neutral",
    "devenv.exe": "Productive",
    "steam.exe": "Unproductive"
  }
}
```

- `TimeSpan` fields serialize as `.NET`'s `"c"`-style constant format (`hh:mm:ss[.fffffff]`) — implement your JSON layer's `TimeSpan` handling to match, or coordinate with the client team on a normalized format (e.g. total seconds as an integer) before go-live if your stack's default differs. **This is flagged as an open item in §9.2** since .NET's default `TimeSpan` JSON representation is not universally portable.
- **`Version` must increment on every policy change.** The Agent only reacts to policy when `Version` differs from its cached copy — an update that doesn't bump `Version` will be silently ignored by every device.
- If this endpoint is unreachable, the Agent continues running on its last-cached policy (written to local disk) or, on first run, hardcoded safe defaults matching the values shown above. Do not assume a device without a network connection is running blind — it is running the last policy it successfully fetched.
- `ProductivityTags` is a flat map of **executable file name → tag string** (currently free-text, e.g. `"Productive"`/`"Unproductive"`/`"Neutral"` — the client does not validate the tag value, it just attaches it to `app-session` records verbatim). Tag computation is entirely client-side; the backend's only job is to deliver this map.

### 4.3 `POST /api/v1/screenshots` — screenshot upload

See §6 for the full binary-handling contract. Endpoint summary:

**Request:** `multipart/form-data` with fields:
| Part | Type | Notes |
|---|---|---|
| `file` | binary (JPEG) | the decrypted image bytes |
| `clientEventId` | string (GUID) | idempotency key |
| `machineId` | string | |
| `capturedAtUtc` | string, ISO 8601 | |

**Response (success, `200 OK`):**

```json
{ "remoteUri": "https://.../screenshots/8f14e45f-....jpg" }
```

`remoteUri` is stored by the client only for its own logging; it is not read back or displayed anywhere on the device.

**Response (failure):** any non-2xx. The Agent retries the same file on the next upload cycle (every 2 minutes by default) until it succeeds or the file ages past the 30-day undelivered-retention window, after which it's deleted locally and logged as data loss.

---

## 5. Shared / Common Data Models

### 5.1 Device and employee identity

| Field            | Source                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MachineId`      | Windows `MachineGuid` (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`) | Stable across the life of the OS install; changes on OS reimage. Treat as the device's primary key.                                                                                                                                                                                                                                                                   |
| `UserSid`        | Windows SID string (`S-1-5-21-...`)                                        | Stable per Windows account, but **the backend must maintain its own SID → Employee mapping** — the Agent has no concept of "employee ID," only the OS-level SID. This mapping is out of scope for the Agent and must be built into the backend/admin console (e.g., an admin enrolls a device and maps the local Windows account SID(s) on it to an employee record). |
| `OrganizationId` | Not yet populated by the client                                            | The `DeviceContext` model has a slot for this, intended to be assigned by the backend at device enrollment and pushed back via policy or a dedicated enrollment response — **flagged as an open item, §9.3**.                                                                                                                                                         |

### 5.2 Timestamp conventions

All timestamps are UTC. The Agent never performs local-time math internally — it converts to local time nowhere. **Local-time display (for dashboards, working-hours evaluation in reports, etc.) is entirely a backend/frontend responsibility.** The device's own local time zone is not currently transmitted in any payload — if your dashboard needs to render "9am local" correctly, you'll need to either infer time zone from IP/device registration data or add a time zone field to device enrollment (flagged §9.4).

### 5.3 Device/entity identity priority (USB)

The Agent identifies USB devices by `PnpDeviceId` (Windows-assigned, stable per physical port enumeration) rather than serial number, because cheap flash drives are well known to report duplicate or blank serial numbers. Do not deduplicate USB sessions by `SerialNumber` — use `PnpDeviceId`.

### 5.4 Productivity tags

Computed entirely client-side using the `ProductivityTags` map from the policy document (§4.2). The backend does not need to compute or validate productivity classification — it only needs to define the map and read the resulting `ProductivityTag` field back on `app-session` events.

### 5.5 Pagination

This spec defines no read/query endpoints (the Agent is write-only against this API, aside from `GET /api/v1/policy` which returns a single document, not a list). If you build reporting/read endpoints for a dashboard, that's backend-owned surface not constrained by this document — standard cursor or offset pagination is fine.

---

## 6. Screenshot / Binary Data Handling

- **Upload mechanism:** `multipart/form-data` POST (§4.3), not a pre-signed URL pattern. The Agent decrypts its locally-encrypted screenshot (AES-256-GCM, DPAPI-protected key, never transmitted) to a temp file immediately before upload and deletes the temp file immediately after, regardless of success — plaintext image bytes exist on disk only for the duration of the HTTP call.
- **Why not pre-signed URLs:** simpler to implement correctly against an unknown backend stack; if your storage layer benefits from direct-to-blob upload (S3/Azure Blob presigned PUT), you can front this endpoint with a redirect or have your ingestion endpoint proxy directly to blob storage — the client only needs a single `POST` call to succeed, however you implement that server-side.
- **Metadata that must accompany every image:** `clientEventId`, `machineId`, `capturedAtUtc` (see §4.3 table). Width/height/monitor count/encoded size are tracked client-side (see the `screenshots` local table) but **are not currently sent to the backend** — only the image and the three fields above. If your dashboard needs image dimensions, either extract them server-side from the JPEG or flag this as a contract addition (§9.5).
- **Format:** JPEG, quality configurable via policy (default 70).
- **Idempotency:** re-uploading the same `clientEventId` should overwrite/no-op rather than create a duplicate — the Agent will retry an upload it isn't sure succeeded.
- **Screenshots are disabled by default** and must be explicitly enabled per-organization via policy.

---

## 7. Non-Functional Requirements

### 7.1 Expected volume (per the 30-workstation deployment this was built for; scale-adjust for larger fleets)

- Attendance: a handful of events per user per day (login/logout/lock/unlock/idle transitions) — low volume.
- App Session: potentially hundreds per user per day (every app switch or window-title change is a session boundary).
- Activity Session: similar order of magnitude to App Session.
- Browser Navigation: potentially hundreds per user per day for heavy browser use.
- USB: rare, event-driven only.
- Alerts: rare, and explicitly deduplicated/escalated rather than repeated (see §4.1.6).
- Screenshots: 0 per day by default; up to ~50/day per user if enabled at the default 10-minute interval during a normal workday.

At 30 devices, this is a low-volume system — do not over-engineer for scale the deployment doesn't need. Design for correctness (idempotency, no data loss) over throughput.

### 7.2 Indexing guidance (advisory — you own final schema design)

- Index `(channel, client_event_id)` unique per the event tables for dedup (§3.2).
- Index `(machine_id, user_sid, occurred_at_utc)` on each event table for per-employee reporting queries.
- Index `(machine_id, user_sid, type, resolved_at_utc)` on alerts, mirroring the client's own local query pattern for "find the currently open alert of this type."

### 7.3 Retention (advisory)

The Agent has no opinion on backend-side retention — that's a policy/legal decision for your organization (see the Privacy Policy document for what's disclosed to employees about retention). Ensure whatever you choose can honor deletion requests (§8).

### 7.4 Logging / audit

Every alert (§4.1.6) is itself an audit trail entry. For broader API-level audit (who queried what, when policy changed and by whom), that's backend/admin-console scope not covered by the Agent.

### 7.5 API versioning

`/api/v1/` prefix reserved for exactly this contract. Introduce `/api/v2/` for breaking changes; the Agent does not currently negotiate versions, so a breaking change requires a coordinated client update.

---

## 8. Consent / Compliance Fields

Per organizational policy (Singapore PDPA, GDPR where applicable), employees must be notified before monitoring begins. The Agent enforces this client-side: no collector starts until the local consent gate is acknowledged (a blocking dialog on first run and after any policy version change).

**The backend must store proof of this acknowledgment.** The Agent does not currently push consent records automatically — this is flagged as an open item (§9.6) since it requires a dedicated endpoint not yet built into `IBackendClient`. When added, expect a shape matching the client's local `ConsentRecord`:

```json
{
  "userSid": "S-1-5-21-...",
  "machineId": "...",
  "policyVersion": 4,
  "acknowledgedAtUtc": "2026-07-27T08:00:00Z"
}
```

Recommended endpoint: `POST /api/v1/consent` with this body, idempotent on `(userSid, machineId, policyVersion)`. Until this exists, the consent record only lives in the device's local encrypted database — **this is a gap, not a design choice**, and should be closed before production rollout, since the backend currently has no way to prove notice was given if asked to demonstrate compliance.

---

## 9. Open Questions for the Backend Developer

These need a decision — from the product owner or backend developer — before or during backend implementation. None of them block starting the work, but all of them affect the final contract:

1. **Authentication scheme** (§2.2): API key vs. JWT, and the enrollment/issuance flow. The Agent is ready for either behind `IBackendClient`, but the concrete token-acquisition code doesn't exist yet since it depends on this choice.
2. **`TimeSpan` JSON format** in the policy document (§4.2): confirm your JSON serializer's `TimeSpan` handling matches .NET's default (`"01:30:00"` style), or agree on an alternative (e.g., total seconds as integers) and update the client accordingly.
3. **`OrganizationId` assignment** (§5.1): how and when a device learns its organization ID — at enrollment, via policy, or some other mechanism.
4. **Time zone for local-time reporting** (§5.2): the Agent transmits no time zone data today; decide whether to add it to device enrollment or infer it elsewhere.
5. **Screenshot metadata completeness** (§6): whether width/height/monitor-count need to be transmitted explicitly or extracted from the image server-side.
6. **Consent record sync endpoint** (§8): this is the most important open item from a compliance standpoint — the backend currently has no way to receive proof of employee notification. Recommend prioritizing this even ahead of full telemetry ingestion.
7. **Partial-batch acknowledgment**: confirm the all-or-nothing batch semantics in §3.3 are acceptable, or scope a coordinated change to support partial acknowledgment if your ingestion pipeline can fail rows independently.
8. **Employee/SID-to-identity mapping**: how admins enroll a device and associate Windows SIDs on it with an actual employee record — entirely a backend/admin-console concern, but necessary before any of this telemetry is meaningful in a report.
