> **ARCHIVED - NOT AUTHORITATIVE.** This document describes an abandoned version of the
> agent. It is kept for history only. Do not build on it.
> The live documentation index is [../../../README.md](../../../README.md); see
> [../../../archive/README.md](../../../archive/README.md) for what superseded this file.

---

# Backend API Specification - Workforce Agent

**Audience:** a backend developer who has not seen the Agent's source code, implementing the server in any stack.
**Status:** the Agent client is fully built against this contract via an `IBackendClient` abstraction. No backend exists yet - this document _is_ the spec the backend must satisfy for the client to work correctly on the first try.

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

Each device runs two cooperating processes (a Windows Service and a per-user tray helper - an internal client-side detail, irrelevant to this API beyond explaining why events for one `MachineId` may arrive tagged with different `UserSid` values as users log on/off). Both talk to the backend through the same three endpoint families described below.

### 1.3 What the Agent does _not_ do

Per organizational policy, the Agent never captures keystroke content, personal account contents, or provides remote control. It also never sends data until the employee has acknowledged the on-device consent notice (see section 8). The backend should treat any payload arriving without a corresponding consent record as a data-handling exception, not silently accept it.

---

## 2. Authentication & Security

### 2.1 Transport

- TLS 1.2 or higher on every endpoint. The Agent's HTTP client is built against a base URL (`https://.../`) with no support for plaintext HTTP.

### 2.2 Device authentication (decided and implemented: API key per device)

The Agent's `IBackendClient` sends every request via a standard `HttpClient` with a bearer token in the `Authorization` header: `Authorization: Bearer <device-api-key>`. The key is:

- **issued once**, when an admin registers the device via the dashboard API (section 2.4) - not self-issued or obtained through any device-initiated exchange. There is no `/auth/token` endpoint; a JWT-exchange scheme was considered but not built, since the fleet size (~30 devices) didn't justify the added complexity of short-lived-token refresh over a per-device revocable secret.
- **stored on the device** via Windows DPAPI, `LocalMachine` scope (`C:\ProgramData\WorkforceAgent\keys\device.key`) - the same protection pattern the Agent already uses for its local database key. See `Agent.Core.Identity.DeviceEnrollmentBootstrapper` / `Agent.Storage.Security.DpapiDeviceCredentialStore` client-side, and `Agent.Sync.DeviceAuthDelegatingHandler` for how it's attached to outgoing requests.
- **verified server-side** by hashing the presented key and looking it up (`Backend/src/middleware/deviceAuth.ts`) - the raw key itself is never stored, only its hash.

### 2.3 Token rotation

The backend returns `401 Unauthorized` for a missing, malformed, or unrecognized credential, and `403 Forbidden` only for a key that hashes to a real, currently-deactivated device (section 2.4's decommission flow). There is no in-place rotation endpoint - see section 2.4 for the rotate/revoke procedure. The Agent does not retry a `401` by re-authenticating (there's nothing to re-authenticate with - a `401` on this scheme means the device was never enrolled, was mis-provisioned, or was deliberately revoked, not that a short-lived token expired), it simply logs the failure and retries the sync cycle on its normal interval; it will keep failing until an admin fixes enrollment.

### 2.4 Device enrollment (production installation) and decommission (uninstall)

This is the production install/uninstall procedure for the backend half of a device - i.e., what an admin does through the dashboard API alongside the client-side install/uninstall steps in `Windows Software/docs/running-the-agent.md` section 3. Full step-by-step admin instructions (including how the key gets from this response onto the actual machine) live in `Windows Software/docs/device-enrollment.md`; this section is the authoritative contract for the two endpoints involved.

A freshly installed Agent (service installed per `running-the-agent.md` section 3.2, tray helper deployed per section 3.3) has no credential yet and will get `401 Unauthorized` on every backend call until enrollment below is completed - this is expected, not a bug, and the Agent falls back to cached/default policy in the meantime (section 4.2).

**Note the path prefix:** enrollment/decommission below live under `/v1/dashboard/...` (an admin-session-authenticated surface, distinct from the device-API-key-authenticated `/api/v1/...` surface the Agent itself calls, per section 4 and section 7.5). They're both part of the same backend, just gated by different credentials - a human admin's dashboard login for these two, the device's own API key for everything the Agent calls directly.

**Prerequisite - create the employee** (if not already present):

```http
POST /v1/dashboard/employees
Authorization: <dashboard session, super_admin role>
{ "organizationId": "<org-uuid>", "name": "Jane Doe", "email": "jane@company.com", "department": "Engineering" }
```

**Step 1 - register the device** (issues the credential the freshly-installed Agent needs):

```http
POST /v1/dashboard/employees/devices
Authorization: <dashboard session, super_admin role>
{
  "employeeId": "<employee-uuid>",
  "machineId": "<Windows MachineGuid - HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid>",
  "hostname": "<hostname>",
  "os": "Windows 11 Pro",
  "agentVersion": "0.1.0"
}
```

`201 Created`:

```json
{
  "message": "Device registered successfully",
  "data": {
    "deviceId": "...",
    "employeeId": "...",
    "organizationId": "...",
    "machineId": "...",
    "hostname": "...",
    "rawApiKey": "<64-char hex device API key>",
    "note": "Save this device API key securely (e.g. via DPAPI on the device). It will not be shown again."
  }
}
```

**`rawApiKey` is returned exactly once and is not recoverable afterward** - only its hash is persisted server-side. Re-registering an already-registered `machineId` is rejected with `400 A device with this machineId is already registered`; there is no upsert.

**Step 2 - provision the key onto the machine** (client-side half of install): the Agent looks for `rawApiKey` in the machine-scoped environment variable `WORKFORCEAGENT_DEVICE_API_KEY` the first time it starts without a stored credential, then imports it into the DPAPI-protected local store described in section 2.2 and never needs the environment variable again. Set it via deployment tooling (Intune, SCCM, GPO Preferences, or a provisioning script run alongside the `sc.exe`/Scheduled Task install steps in `running-the-agent.md` section 3.2-3.3):

```powershell
[Environment]::SetEnvironmentVariable('WORKFORCEAGENT_DEVICE_API_KEY', '<rawApiKey>', 'Machine')
```

Confirm success via `"Device enrolled successfully"` in `agent-*.log`; see `device-enrollment.md` for the full troubleshooting checklist (most common failure: the service/tray process was already running when the env var was set and needs a restart to see it).

**Uninstall / decommission a device:**

```http
PATCH /v1/dashboard/employees/devices/:deviceId/status
Authorization: <dashboard session, super_admin role>
{ "isActive": false }
```

`200 OK`, and every subsequent request from that device's API key now gets `403 Forbidden` (not `401` - the credential is still recognized, just deliberately revoked, which is what lets an admin distinguish "this device was decommissioned on purpose" from "this device was never enrolled" when reading logs). Do this as part of every machine decommission/re-image, **before** uninstalling the Agent client-side (`running-the-agent.md` section 3.4) - revoking first means any stray sync attempt during uninstall fails closed rather than continuing to push telemetry from a machine being retired.

There is no delete-device endpoint - deactivation (`isActive: false`) is the only supported decommission path, preserving the device's historical telemetry and audit trail. Reactivating a previously decommissioned device (e.g., a machine returning from storage) is the same endpoint with `isActive: true`; its existing API key remains valid, nothing needs to be re-provisioned on the machine.

**Key rotation** (suspected compromise, not routine decommission): there is no rotate-in-place endpoint. Deactivate the device (above), register a new device row for the same employee/`machineId` - wait, `machineId` is unique, so first deactivate, then the old row still occupies that `machineId` and a straight re-register will still 400. The supported path today is: deactivate the old device row, then have the backend developer either free up the `machineId` (e.g. a dedicated rotate endpoint, not yet built) or register the replacement under a fresh install with a re-imaged `machineId`. Treat scheduled key rotation as a backend follow-up, not something achievable purely through today's endpoints - flagged in `device-enrollment.md`.

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

**The backend must deduplicate on `clientEventId` per channel** (e.g., a unique constraint on `(channel, client_event_id)`), and the push response must report back only the IDs it can now confirm are durably stored - including ones that turn out to be duplicates of already-stored rows. The Agent deletes an event from its local queue as soon as its ID appears in `acknowledgedEventIds`; anything not acknowledged is retried automatically (with exponential backoff, capped between 5 seconds and 2 minutes by default) - the backend does not need to manage retry logic itself.

### 3.3 Acknowledgment contract

A push is either fully processed or the backend returns a non-2xx status (the Agent does not currently support partial-batch semantics like "207 Multi-Status" - treat the whole batch atomically: either persist everything and return all IDs in `acknowledgedEventIds`, or persist nothing and return a non-2xx so the whole batch retries). If you want partial-success semantics in a future version, that's a coordinated client+server change, not something to add unilaterally on the backend.

### 3.4 Data the Agent purges locally - the backend is the system of record after ack

Once acknowledged, the Agent deletes its local copy immediately. If a device is offline for more than 30 days (admin-configurable), it purges unsynced data and logs that as a local data-loss event - there is no other resend mechanism, so once a batch is gone, it's gone. Backend retention/backup planning should account for the fact that the Agent is _not_ a durable backing store beyond that window.

---

## 4. Endpoint-by-Endpoint Contract

All endpoints are versioned under `/api/v1/`. All timestamps are UTC, ISO 8601 (`.NET "O"` round-trip format, e.g. `2026-07-27T14:32:05.1234567+00:00`).

### 4.1 `POST /api/v1/events/{channel}` - generic telemetry ingestion

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

`payloadJson` is a JSON string (double-encoded) containing the full channel-specific event object described below - the Agent serializes its internal C# record directly, so the field names are exactly as documented per channel.

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

#### 4.1.1 Channel `attendance` - Attendance module

| Field           | Type           | Required | Notes                                                                                 |
| --------------- | -------------- | -------- | ------------------------------------------------------------------------------------- |
| ClientEventId   | GUID           | yes      | idempotency key                                                                       |
| MachineId       | string         | yes      | see section 5.1                                                                              |
| UserSid         | string         | yes      | Windows SID, see section 5.1                                                                 |
| SessionId       | int            | yes      | Windows logon session ID (not stable across reboots)                                  |
| IsRemoteSession | bool           | yes      | true if RDP                                                                           |
| EventType       | string enum    | yes      | `Login`, `Logout`, `Lock`, `Unlock`, `SleepStart`, `SleepEnd`, `IdleStart`, `IdleEnd` |
| OccurredAtUtc   | ISO 8601       | yes      |                                                                                       |
| Reason          | string \| null | no       | set only for synthetic events, e.g. `"ServiceRestartRecovery"` - see section 7               |

Backend derivation note: the Agent sends raw state-transition events, not computed "hours worked." Daily attendance summaries (logged-in time minus merged idle/lock/sleep intervals) must be computed backend-side (or reused from the client's own algorithm, described in the module's design notes) if your dashboard needs a single "hours worked today" number. Session boundaries split at **UTC midnight**, not local midnight.

#### 4.1.2 Channel `app-session` - Active App Session module

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
| EndTimeUtc       | ISO 8601       | yes      | only sent once the session is closed - the Agent never syncs an open session |
| ProductivityTag  | string \| null | no       | see section 5.4                                                                     |

#### 4.1.3 Channel `activity-session` - Active vs Idle module

| Field                    | Type        | Required | Notes                                                                                               |
| ------------------------ | ----------- | -------- | --------------------------------------------------------------------------------------------------- |
| ClientEventId            | GUID        | yes      |                                                                                                     |
| MachineId, UserSid       | string      | yes      |                                                                                                     |
| State                    | string enum | yes      | `Active`, `Idle`, `Locked`, `Sleeping`, `Offline`                                                   |
| Reason                   | string enum | yes      | `None`, `NoInput`, `Meeting`, `Presentation`, `CpuBusy`, `SuspiciousActivity`, `PossibleAutomation` |
| StartTimeUtc, EndTimeUtc | ISO 8601    | yes      |                                                                                                     |

#### 4.1.4 Channel `browser-navigation` - Browser Monitor module

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

#### 4.1.5 Channel `usb-device` - USB Logs module

| Field                             | Type           | Required | Notes                                                                                                                                   |
| --------------------------------- | -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| ClientEventId                     | GUID           | yes      |                                                                                                                                         |
| MachineId                         | string         | yes      |                                                                                                                                         |
| UserSid                           | string         | yes      | the active console user at the time of the event - USB devices belong to the machine, not a session, so this is best-effort attribution |
| PnpDeviceId                       | string         | yes      | **the stable device identity** - use this, not SerialNumber, as the dedup/correlation key (see rationale in section 5.3)                       |
| SerialNumber, Model, Manufacturer | string \| null | no       |                                                                                                                                         |
| CapacityBytes                     | long \| null   | no       |                                                                                                                                         |
| Volumes                           | array          | yes      | `[{ "DriveLetter": "E:", "VolumeLabel": "MyDrive", "FileSystem": "FAT32" }, ...]` - may be empty (device present, not yet mounted)      |
| EventType                         | string enum    | yes      | `Inserted`, `MetadataChanged`, `Removed`                                                                                                |
| OccurredAtUtc                     | ISO 8601       | yes      |                                                                                                                                         |

A "session" (one physical insert-to-remove lifecycle) is the sequence of events sharing the same `PnpDeviceId` between an `Inserted` and the next `Removed` for that ID.

#### 4.1.6 Channel `alert` - Alerts module

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
| EscalationLevel                                     | int              | yes      | increments each time the same open alert re-fires at a higher severity (e.g. idle Warning->High->Critical is one alert, escalation levels 1->2->3)                                                                      |
| NotificationCount                                   | int              | yes      | how many times this alert has actually been shown to the employee                                                                                                                                                   |

**Important:** the same `ClientEventId` for an alert is reused across escalations (it's the same underlying incident being updated, not a new event each time) - the backend should `UPSERT` on `ClientEventId` for this channel specifically, rather than treating every push as an insert-only append like the other channels.

### 4.2 `GET /api/v1/policy` - policy distribution

**Purpose:** the Agent polls this every 2 minutes (independent of the sync batch cycle) to pick up admin-configured changes without a restart.

**Request:** no body. The device's identity comes from the auth token (section 2).

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

- `TimeSpan` fields serialize as `.NET`'s `"c"`-style constant format (`hh:mm:ss[.fffffff]`) - implement your JSON layer's `TimeSpan` handling to match, or coordinate with the client team on a normalized format (e.g. total seconds as an integer) before go-live if your stack's default differs. **This is flagged as an open item in section 9.2** since .NET's default `TimeSpan` JSON representation is not universally portable.
- **`Version` must increment on every policy change.** The Agent only reacts to policy when `Version` differs from its cached copy - an update that doesn't bump `Version` will be silently ignored by every device.
- If this endpoint is unreachable, the Agent continues running on its last-cached policy (written to local disk) or, on first run, hardcoded safe defaults matching the values shown above. Do not assume a device without a network connection is running blind - it is running the last policy it successfully fetched.
- `ProductivityTags` is a flat map of **executable file name -> tag string** (currently free-text, e.g. `"Productive"`/`"Unproductive"`/`"Neutral"` - the client does not validate the tag value, it just attaches it to `app-session` records verbatim). Tag computation is entirely client-side; the backend's only job is to deliver this map.

### 4.3 `POST /api/v1/screenshots` - screenshot upload

See section 6 for the full binary-handling contract. Endpoint summary:

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
| `UserSid`        | Windows SID string (`S-1-5-21-...`)                                        | Stable per Windows account, but **the backend must maintain its own SID -> Employee mapping** - the Agent has no concept of "employee ID," only the OS-level SID. This mapping is out of scope for the Agent and must be built into the backend/admin console (e.g., an admin enrolls a device and maps the local Windows account SID(s) on it to an employee record). |
| `OrganizationId` | Not yet populated by the client                                            | The `DeviceContext` model has a slot for this, intended to be assigned by the backend at device enrollment and pushed back via policy or a dedicated enrollment response - **flagged as an open item, section 9.3**.                                                                                                                                                         |

### 5.2 Timestamp conventions

All timestamps are UTC. The Agent never performs local-time math internally - it converts to local time nowhere. **Local-time display (for dashboards, working-hours evaluation in reports, etc.) is entirely a backend/frontend responsibility.** The device's own local time zone is not currently transmitted in any payload - if your dashboard needs to render "9am local" correctly, you'll need to either infer time zone from IP/device registration data or add a time zone field to device enrollment (flagged section 9.4).

### 5.3 Device/entity identity priority (USB)

The Agent identifies USB devices by `PnpDeviceId` (Windows-assigned, stable per physical port enumeration) rather than serial number, because cheap flash drives are well known to report duplicate or blank serial numbers. Do not deduplicate USB sessions by `SerialNumber` - use `PnpDeviceId`.

### 5.4 Productivity tags

Computed entirely client-side using the `ProductivityTags` map from the policy document (section 4.2). The backend does not need to compute or validate productivity classification - it only needs to define the map and read the resulting `ProductivityTag` field back on `app-session` events.

### 5.5 Pagination

This spec defines no read/query endpoints (the Agent is write-only against this API, aside from `GET /api/v1/policy` which returns a single document, not a list). If you build reporting/read endpoints for a dashboard, that's backend-owned surface not constrained by this document - standard cursor or offset pagination is fine.

---

## 6. Screenshot / Binary Data Handling

- **Upload mechanism:** `multipart/form-data` POST (section 4.3), not a pre-signed URL pattern. The Agent decrypts its locally-encrypted screenshot (AES-256-GCM, DPAPI-protected key, never transmitted) to a temp file immediately before upload and deletes the temp file immediately after, regardless of success - plaintext image bytes exist on disk only for the duration of the HTTP call.
- **Why not pre-signed URLs:** simpler to implement correctly against an unknown backend stack; if your storage layer benefits from direct-to-blob upload (S3/Azure Blob presigned PUT), you can front this endpoint with a redirect or have your ingestion endpoint proxy directly to blob storage - the client only needs a single `POST` call to succeed, however you implement that server-side.
- **Metadata that must accompany every image:** `clientEventId`, `machineId`, `capturedAtUtc` (see section 4.3 table). Width/height/monitor count/encoded size are tracked client-side (see the `screenshots` local table) but **are not currently sent to the backend** - only the image and the three fields above. If your dashboard needs image dimensions, either extract them server-side from the JPEG or flag this as a contract addition (section 9.5).
- **Format:** JPEG, quality configurable via policy (default 70).
- **Idempotency:** re-uploading the same `clientEventId` should overwrite/no-op rather than create a duplicate - the Agent will retry an upload it isn't sure succeeded.
- **Screenshots are disabled by default** and must be explicitly enabled per-organization via policy.

---

## 7. Non-Functional Requirements

### 7.1 Expected volume (per the 30-workstation deployment this was built for; scale-adjust for larger fleets)

- Attendance: a handful of events per user per day (login/logout/lock/unlock/idle transitions) - low volume.
- App Session: potentially hundreds per user per day (every app switch or window-title change is a session boundary).
- Activity Session: similar order of magnitude to App Session.
- Browser Navigation: potentially hundreds per user per day for heavy browser use.
- USB: rare, event-driven only.
- Alerts: rare, and explicitly deduplicated/escalated rather than repeated (see section 4.1.6).
- Screenshots: 0 per day by default; up to ~50/day per user if enabled at the default 10-minute interval during a normal workday.

At 30 devices, this is a low-volume system - do not over-engineer for scale the deployment doesn't need. Design for correctness (idempotency, no data loss) over throughput.

### 7.2 Indexing guidance (advisory - you own final schema design)

- Index `(channel, client_event_id)` unique per the event tables for dedup (section 3.2).
- Index `(machine_id, user_sid, occurred_at_utc)` on each event table for per-employee reporting queries.
- Index `(machine_id, user_sid, type, resolved_at_utc)` on alerts, mirroring the client's own local query pattern for "find the currently open alert of this type."

### 7.3 Retention (advisory)

The Agent has no opinion on backend-side retention - that's a policy/legal decision for your organization (see the Privacy Policy document for what's disclosed to employees about retention). Ensure whatever you choose can honor deletion requests (section 8).

### 7.4 Logging / audit

Every alert (section 4.1.6) is itself an audit trail entry. For broader API-level audit (who queried what, when policy changed and by whom), that's backend/admin-console scope not covered by the Agent.

### 7.5 API versioning

`/api/v1/` prefix reserved for exactly this contract. Introduce `/api/v2/` for breaking changes; the Agent does not currently negotiate versions, so a breaking change requires a coordinated client update.

---

## 8. Consent / Compliance Fields

Per organizational policy (Singapore PDPA, GDPR where applicable), employees must be notified before monitoring begins. The Agent enforces this client-side: no collector starts until the local consent gate is acknowledged (a blocking dialog on first run and after any policy version change).

**The backend stores proof of this acknowledgment.** `POST /api/v1/consent` (device-authenticated, same as the ingestion endpoints in section 4.1) is implemented and the Agent calls it via `IBackendClient.PostConsentAsync` whenever the local consent gate is acknowledged. Body:

```json
{
  "userSid": "S-1-5-21-...",
  "machineId": "...",
  "policyVersion": 4,
  "acknowledgedAtUtc": "2026-07-27T08:00:00Z"
}
```

`200 OK` on success; no dedicated response body is required beyond a 2xx status. As with the event channels (section 3.2), treat this as idempotent on `(userSid, machineId, policyVersion)` - the Agent re-sends the same acknowledgment on every consent-gate pass until it gets a successful response, so a repeat post for a policy version already on file should upsert/no-op rather than error.

---

## 9. Open Questions for the Backend Developer

These need a decision - from the product owner or backend developer - before or during backend implementation. None of them block starting the work, but all of them affect the final contract:

1. ~~**Authentication scheme**~~ - **Resolved.** API key per device, issued via `POST /v1/dashboard/employees/devices`. See section 2.2-2.4.
2. **`TimeSpan` JSON format** in the policy document (section 4.2): confirm your JSON serializer's `TimeSpan` handling matches .NET's default (`"01:30:00"` style), or agree on an alternative (e.g., total seconds as integers) and update the client accordingly.
3. ~~**`OrganizationId` assignment**~~ - **Resolved, differently than originally proposed.** The Agent still never learns its own `OrganizationId` locally, and doesn't need to: the backend derives it server-side from the authenticated device (`req.device.organizationId` in `deviceAuth.ts`, set from the `Device` row created at enrollment) on every request. No client or contract change was needed.
4. **Time zone for local-time reporting** (section 5.2): the Agent transmits no time zone data today; decide whether to add it to device enrollment or infer it elsewhere.
5. **Screenshot metadata completeness** (section 6): whether width/height/monitor-count need to be transmitted explicitly or extracted from the image server-side.
6. ~~**Consent record sync endpoint**~~ - **Resolved.** `POST /api/v1/consent` is implemented and wired into the Agent (`IBackendClient.PostConsentAsync`). See section 8.
7. **Partial-batch acknowledgment**: confirm the all-or-nothing batch semantics in section 3.3 are acceptable, or scope a coordinated change to support partial acknowledgment if your ingestion pipeline can fail rows independently.
8. ~~**Employee/SID-to-identity mapping**~~ - **Resolved, at device granularity.** Each `Device` row is registered directly against one `Employee` (section 2.4 step 1) - there's no separate SID<->employee table. This assumes one primary employee per machine; a genuinely shared machine (multiple SIDs, no single owner) has no way to attribute events to different employees today. Flag this to the product owner if shared/kiosk-style machines are in scope - otherwise no action needed.
