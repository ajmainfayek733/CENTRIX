# Data model

PostgreSQL via Prisma. Source of truth: `Backend/prisma/schema.prisma`.

Models are `PascalCase`; tables are `snake_case` via `@@map` so raw SQL and BI tools see
conventional names. Primary keys are `uuid` unless stated.

**No JSON columns anywhere.** Every telemetry field has its own typed column (AD-03).

---

## Table map

| Model | Table | Holds |
|---|---|---|
| `Organization` | `organizations` | The tenant. Owns the enrollment token hash |
| `Employee` | `employees` | People, including the hidden "Unassigned Devices" placeholder |
| `Device` | `devices` | Enrolled workstations |
| `Policy` | `policies` | One row per organization, all admin-editable settings |
| `Category` | `categories` | App/domain productivity and blacklist rules |
| `ConsentRecord` | `consent_records` | Per user, per policy version |
| `IngestBatch` | `ingest_batches` | Batch idempotency ledger |
| `DailyActivityRollup` | `daily_activity_rollups` | **What every report reads** |
| `AttendanceSession` | `attendance_sessions` | Login/logout sessions |
| `ActivityMetric` | `activity_metrics` | Key/mouse **counts** |
| `ActivitySession` | `activity_sessions` | Foreground app / idle / lock intervals |
| `BrowserActivity` | `browser_activity` | URL visits |
| `UsbEvent` | `usb_events` | Device connect/disconnect metadata |
| `Alert` | `alerts` | Raised alerts, upserted on escalation |
| `Screenshot` | `screenshots` | Capture metadata; bytes live on disk |
| `User`, `Session`, `Account`, `Verification` | `users`, `sessions`, `accounts`, `verifications` | Better Auth |
| `AuditLog` | `audit_logs` | Who viewed or changed what |

---

## Identity and tenancy

### `organizations`

| Column | Notes |
|---|---|
| `enrollmentTokenHash` | **unique**, nullable. HMAC with an `enrollment:` domain prefix so it can never collide with a device key hash |

### `employees`

| Column | Notes |
|---|---|
| `email` | **unique**. The placeholder uses `unassigned+<orgId>@local.invalid` |
| `status` | `placeholder` marks the hidden "Unassigned Devices" employee |

Index: `(organizationId)`.

### `devices`

| Column | Notes |
|---|---|
| `deviceId` | **unique** - the Windows MachineGuid. The identity key |
| `apiKeyHash` | **unique** - HMAC of the device API key. Lookup is one indexed read, inherently constant-time |
| `macAddress` | Metadata only, normalized to uppercase colon form; all-zero stored as `null` |
| `isActive` | The kill switch. `false` gives 403 everywhere, including re-enrollment |
| `lastSeen` | Written by authenticated HTTP requests, throttled to 60s. **"Online now" is derived from this, never from socket presence** |
| `employeeId` | Points at the placeholder until an admin assigns it |

Indexes: `(organizationId)`, `(employeeId)`, `(macAddress)`.

---

## The rollup

### `daily_activity_rollups`

**Every aggregate report reads this and only this.** One row per employee per day per device.

Unique: `(workDate, deviceId, employeeId)`
Indexes: `(employeeId, workDate)`, `(organizationId, workDate)`

`deviceId` is part of the key, so a device reassigned mid-day produces two rows rather than one row
changing owner.

| Column group | Columns |
|---|---|
| Time | `activeSeconds`, `idleSeconds` |
| Productivity | `productiveSeconds`, `unproductiveSeconds`, `neutralSeconds`, `blacklistedSeconds` |
| Input | `keyCount`, `mouseCount` |
| Counts | `activitySessionCount`, `browserVisitCount`, `usbEventCount`, `alertCount` |
| Bounds | `firstActivityAt`, `lastActivityAt` |

**These counters are incremented inside the ingest transaction, never recomputed.** There is no
repair pass - a double count is permanent and silent. The upsert is raw SQL with `LEAST`/`GREATEST`
because the activity bounds need comparison against stored values, which Prisma cannot express.

`workDate` is the employee's **local** calendar date, not a UTC date. See
[../backend/ingest.md](../backend/ingest.md) section 6.

---

## Telemetry tables

Each has a unique client-generated id that is the deduplication key, and `deviceId` as the owner.

| Table | Dedup key | Write mode | Indexes |
|---|---|---|---|
| `attendance_sessions` | `sessionId` | upsert | `(deviceId, workDate)`, `(userSid, workDate)`, `(logoutTime, loginTime)`, `(deviceId, userSid, loginTime)` |
| `activity_metrics` | `clientEventId` | insert | `(deviceId, windowEndUtc)`, `(sessionId)` |
| `activity_sessions` | `activitySessionId` | insert | `(deviceId, startTime)`, `(sessionId, startTime)`, `(deviceId, productivityTag)` |
| `browser_activity` | `browserActivityId` | insert | `(deviceId, startTime)`, `(domain)`, `(activitySessionId)` |
| `usb_events` | `clientEventId` | insert | `(deviceId, eventTime)`, `(serialNumber)` |
| `alerts` | `clientEventId` | upsert | `(deviceId, triggeredAt)`, `(userSid, type, resolvedAt)`, `(severity, state)` |
| `screenshots` | `clientEventId` | upsert | `(deviceId, capturedAt)` |

Notes worth carrying:

- **`attendance_sessions.logoutSource` says who stamped the logout, and therefore what it is
  worth.** `Agent` means the workstation observed the end - final, never revised. `Server` means
  the row was abandoned and the reaper inferred an end from the last evidence available, because a
  machine that loses power closes nothing and its agent's recovery pass only runs if it boots
  again; that estimate is overwritten by the agent's own report whenever it arrives, including one
  that reopens the row. Null on an open row, and on rows closed before the column existed - those
  predate the reaper, so they are read as final. The two extra indexes serve the sweep: the open
  rows oldest first, and the next login on the same workstation for the same user. See
  [../backend/ingest.md](../backend/ingest.md) section 9.
- **`activity_metrics` has no field that could hold a character.** Counts only, structurally.
- **`browser_activity.activitySessionId` is a nullable FK.** The parent app session closes *after*
  the visits inside it, so an unknown parent is nulled rather than rejected.
- **`usb_events.sessionId` is nullable** for the same reason, and `capacityBytes` is a `BigInt` -
  drive capacities exceed JSON's safe integer range, so it travels as a decimal string.
- **`alerts` is upserted** because an escalating incident reuses one `clientEventId`. Every alert is
  written; only first sightings are counted.
- **`screenshots` stores a path**, not bytes. The files live under `SCREENSHOT_STORAGE_DIR`.

The `(deviceId, <timestamp>)` indexes are what make keyset pagination a constant-cost seek per
page. The keyset cursor is `(timestamp, id)` - see
[../backend/reporting.md](../backend/reporting.md) section 2.

---

## Supporting tables

### `ingest_batches`

Unique `(deviceId, batchId)`, index `(receivedAt)`.

| Column | Notes |
|---|---|
| `eventIdsHash` | SHA-256 of the **sorted** event ids, so a reordered retry still matches |
| `eventCount`, `channel` | |

Written **last and inside the ingest transaction**, so it can never claim a batch that did not
land. Pruned after `INGEST_BATCH_RETENTION_DAYS`.

### `policies`

Unique `(organizationId)`. Every column carries a default matching the agent's compiled-in
defaults, so an empty `create` seeds a complete policy. `version` increments on every write.

`workingDays` is a Postgres `text[]` - a real array column, not a serialized document. Full field
list in [configuration.md](configuration.md#policy-fields).

### `categories`

Unique `(organizationId, target, pattern)`, index `(organizationId, target)`. `target` is
`App` or `Domain`; matching is case-insensitive. `isBlacklisted` drives blacklist alerts.

**The server re-derives `productivityTag` at ingest from these rules and its answer wins** over the
agent's, whose copy can be a policy version behind.

### `consent_records`

Unique `(deviceId, userSid, policyVersion)`. A version change re-prompts on the workstation.

### `audit_logs`

Index `(userId, timestamp)`. Written on response `finish`, 2xx only. **Reads are audited, not just
writes** - screenshot views individually.

---

## Enums

| Enum | Values |
|---|---|
| `ActivityType` | `Application`, `Desktop`, `Locked`, `Idle`, `Sleeping`, `Disconnected` |
| `ActivityEndReason` | `UserInactivity`, `ScreenLock`, `Sleep`, `Disconnect`, `AppSwitch`, `SessionEnd` |
| `ProductivityTag` | `Productive`, `Unproductive`, `Blacklisted`, `Neutral` |
| `SessionEndReason` | `Logout`, `Lock`, `Shutdown`, `Restart`, `Hibernate`, `Sleep`, `PowerLoss`, `Disconnect`, `Recovered` |
| `UsbEventType` | `Connected`, `Disconnected` |
| `UsbDeviceType` | `UsbStorage`, `MobileDevice`, `Hid`, `Other` |
| `BrowserKind` | `Chrome`, `Edge`, `Firefox`, `Brave`, `Opera`, `Vivaldi`, `Other` |
| `UrlProtocol` | `Http`, `Https` |
| `AlertSeverity` | `Information`, `Warning`, `High`, `Critical` |
| `AlertState` | `New`, `Shown`, `Acknowledged`, `Resolved`, `Archived` |
| `AlertType` | `IdleThreshold`, `BlacklistedApp`, `BlacklistedWebsite`, `UsbDeviceConnected` |
| `CategoryTarget` | `App`, `Domain` |
| `UserRole` | `super_admin`, `manager`, `auditor` |

Enums are serialized as **strings** on the wire and mirrored in `Agent.Core/Contracts/Enums.cs`.
**Removing a member poisons events already queued on workstations.** See
[../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md).

---

## Migrations

```bash
cd Backend
npx prisma migrate dev      # development
npx prisma migrate deploy   # production
```

Under Docker compose, migrations run as a one-shot `migrate` service kept separate from `api` so
they cannot race when `api` is scaled.

---

## Related

- [../backend/ingest.md](../backend/ingest.md) - what writes these tables
- [../backend/reporting.md](../backend/reporting.md) - what reads them
- [agent-api.md](agent-api.md) - the wire shapes that land here
- [configuration.md](configuration.md) - the `policies` table in full
- [../operations/diagnostics.md](../operations/diagnostics.md) - useful queries
