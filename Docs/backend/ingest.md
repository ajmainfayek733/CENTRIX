# Ingest - the agent write path

Everything under `/api/v1/*`. Source: `Backend/src/modules/ingest/`.

This is the highest-volume, least-forgiving code in the system. It runs unattended against
clients that retry, arrive out of order, and can be days behind.

| File                   | Responsibility                                                       |
| ---------------------- | -------------------------------------------------------------------- |
| `ingest.routes.ts`     | Route table, rate-limit keys, per-channel validation                 |
| `ingest.dto.ts`        | Zod schema per channel - the wire contract                           |
| `ingestController.ts`  | Thin: unwrap, call, respond                                          |
| `ingestService.ts`     | Enrollment, dedup, prepare/write split, rollup, consent, screenshots |
| `rollupService.ts`     | Daily aggregation, incremented never recomputed                      |
| `policyService.ts`     | Full policy document, created on demand                              |
| `screenshotStorage.ts` | Filesystem persistence - the swap point for blob storage             |
| `upload.ts`            | Multer config, `SCREENSHOT_FILE_FIELD`                               |
| `deviceLiveness.ts`    | Throttled `lastSeen` writes, shared with realtime                    |

---

## 1. Enrollment

`POST /api/v1/device/enroll` trades the **org-wide** enrollment token for a **per-device** API
key. There is no per-machine provisioning step: the same token goes into every install.

```
enrollment token --HMAC--> organizations.enrollmentTokenHash   (lookup)
                                    |
        generate 32-byte device API key, return it ONCE
                                    |
                     HMAC --> devices.apiKeyHash               (stored)
```

Only hashes are persisted, on both sides. The pepper is `DEVICE_TOKEN_PEPPER`, which the server
refuses to start without in production.

Four behaviours worth knowing:

- **Re-enrollment is idempotent on `deviceId` (MachineGuid) and issues a fresh key.** A rebuilt
  workstation recovers with no admin action. This is safe because presenting the enrollment token
  is already an install-time privileged act.
- **The employee assignment survives re-enrollment.** Only the key and profile change.
- **A deactivated device gets 403, not a new key.** Reinstalling is not a way around the kill
  switch.
- **An unknown workstation is accepted, not rejected.** It parks on the org's hidden
  "Unassigned Devices" placeholder employee and appears on the Devices screen. Rejecting it would
  mean no telemetry at all until somebody noticed the machine.

**Its telemetry is stored but never reaches per-employee reports until assigned.** This is the
single most common "the agent is not working" report that is not a bug - see
[../operations/troubleshooting.md](../operations/troubleshooting.md).

`macAddress` is recorded as an attribute but is never an identity key (AD-04). A previously known
address is kept rather than overwritten with null, so an agent that enrolls before its NIC is up
does not erase what was learned last time.

## 2. Authentication and liveness

`deviceAuth` looks the key up by HMAC on a unique indexed column - a single indexed read,
inherently constant-time with respect to the presented key.

| Status | Meaning                                       | Agent behaviour |
| ------ | --------------------------------------------- | --------------- |
| 401    | Missing, malformed or unrecognized credential | Re-enroll       |
| 403    | Authenticated but deliberately deactivated    | Stop pushing    |

The two are distinct because the agent must react differently. Do not collapse them.

`lastSeen` is written through `touchDeviceLastSeen`, throttled by
`DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS` (60s) and shared with the realtime heartbeat so both
paths agree what "recently seen" means. Writing on every request would be a row update per
telemetry call - pure write amplification on the hottest table. The write is fire-and-forget:
liveness tracking must never fail the request it rides on.

## 3. The six channels

`POST /api/v1/events/:channel`, one Zod schema each, fields landing in their own typed columns.

| Channel            | Key                 | Write mode | Rollup contribution                  |
| ------------------ | ------------------- | ---------- | ------------------------------------ |
| `attendance`       | `sessionId`         | **upsert** | Dates only - no seconds              |
| `activity-metric`  | `clientEventId`     | insert     | Key/mouse counts                     |
| `activity-session` | `activitySessionId` | insert     | Active/idle and productivity seconds |
| `browser-activity` | `browserActivityId` | insert     | Visit count only                     |
| `usb-event`        | `clientEventId`     | insert     | Event count                          |
| `alert`            | `clientEventId`     | **upsert** | Count, first sighting only           |

Two upserts, and both have a reason:

- **Attendance** is re-sent by an open session every couple of minutes as its running totals grow,
  so later writes overwrite earlier ones - where **"later" is the agent's `revision`, not the shape
  of the report**. One session produces a stream of snapshots (open at 0s, open at 120s, closed at
  215s) and the queue is at-least-once over a link that can be down for hours, so they do not
  arrive in the order they were written. The agent stamps a counter per session, starting at 1 and
  bumped on every rewrite of the row; ingest drops any report whose revision is below the one
  stored (`revision: { lte }` on the guarded `updateMany`). Equal revisions still apply, because a
  redelivered batch carries the same values.

  Revision `0` means the agent predates the counter. Those reports are unordered and fall back to
  the rules below, which is why the rules are still enforced. The **reaper never touches
  `revision`** - raising it would make the next genuine agent report look stale against a number
  the agent never issued.

  Ordering aside, the row is **final once the agent stamps `logoutTime`, after which further
  writes are dropped**. The agent closes a session once and sends a new
  `sessionId` when presence resumes, so a write against a closed row is stale by definition.
  Enforced here as well as on the agent because sync is at-least-once over an offline queue: a
  retried batch, or one from an agent still on the old build, must not be able to blank a logout
  that has already been reported. That is exactly what produced days of logins with no logout - the
  null `logoutTime` meaning "still open" landing on a row closed minutes earlier.

  A logout the **server** inferred is the one exception - see
  [Abandoned sessions](#9-abandoned-sessions---closing-what-the-workstation-never-could). It carries
  `logoutSource = Server` and any later agent report overwrites it, including a "still open"
  refresh, which reopens the row. Only `logoutSource = Agent` closes the door. A row closed before
  that column existed has a null source and is treated as final.

  Duplicate `sessionId`s **within one batch** are collapsed before the write, the highest revision
  winning - or, when the revisions are equal, the close winning over a refresh. Array order is not
  part of the wire contract, and applying two events for one session in arrival order would
  reintroduce the same bug from inside a single push.

- **Alerts** escalate (idle 30 -> 45 -> 60 min) reusing one `clientEventId` rather than creating
  a row per escalation. Every alert is written; only first sightings are **counted**, or an
  escalation would inflate the day's alert total on every re-send.

**Attendance contributes no seconds to the rollup.** Its `totalActiveSeconds` is the agent's own
sum of activity sessions it already sent - counting both would double every working day.

**Browser time is not added to `activeSeconds`.** The containing `ActivitySession` already
counted that interval.

### Out-of-order arrival

`browser-activity` references an `activitySessionId` that may not have arrived yet - an app
session closes _after_ the browser visits inside it. Unknown parents are **nulled rather than
rejected**, so an out-of-order batch is not lost. `usb-event.sessionId` is treated the same way.

### Server-side re-categorization

For `activity-session` and `browser-activity` the server re-derives `productivityTag` from the
organization's category rules and **its answer wins**. The agent's rules can be a policy version
behind, and reports must be consistent with what the admin sees now. The agent's tag is kept only
when no rule matches.

## 4. Idempotency - two layers

The agent's queue is at-least-once. A batch that committed but whose response was lost is resent
verbatim.

**Layer 1 - per batch.** `ingest_batches(deviceId, batchId)` plus a SHA-256 of the **sorted,
canonical full event contents**. A recognized replay is answered from the ledger without touching
telemetry tables at all. Sorting means a retry that repacked the same events in a different order
still matches, while changed event fields do not. This distinction matters for attendance:
successive snapshots may reuse `clientEventId` while changing `revision`, `logoutTime`, or totals.
This is the layer that matters when a whole fleet reconnects after an outage.

A recurring `batchId` with _different_ contents falls back to per-event dedup with a warning -
trusting the ledger there would silently discard real telemetry.

**Layer 2 - per event.** Unique `clientEventId` per channel. The backstop for a retry that
repacked events into a different batch.

Layer 2 is also what makes the rollup exact (see below).

The ledger is pruned by `pruneIngestBatches()` after `INGEST_BATCH_RETENTION_DAYS` (7), on the
maintenance schedule (section 9) every `INGEST_BATCH_PRUNE_INTERVAL_SECONDS`. It only has to
outlive the agent's retry window.

## 5. Prepare, then write

```
prepare()   OUTSIDE the transaction   existing-id lookup, work-date resolution,
                                      category matching, rollup accumulation
    |
transaction  rows + rollup + ledger, together or not at all
```

Splitting these is the difference between a transaction holding locks through several category
lookups and one holding them only for the inserts. With 100 agents syncing on the same interval,
that gap is contention or none.

`createMany` keeps `skipDuplicates: true` even though the caller already filtered: the filter read
happened outside the transaction, so a concurrent insert would otherwise abort the whole batch
instead of being absorbed.

The transaction is bounded by `INGEST_TRANSACTION_TIMEOUT_MS` (15s) so a wedged transaction cannot
hold locks indefinitely.

## 6. The daily rollup

`daily_activity_rollups`, one row per `(workDate, deviceId, employeeId)`, maintained at ingest
time. Reports read this and never scan the log tables (AD-05).

Browser visits also maintain `browser_daily_summaries`, one row per `(workDate, employeeId, domain)`.
It stores total duration, visit count, and duration buckets by productivity tag so monthly domain
reports merge visits across devices without scanning `browser_activity`.

**Counters are incremented, never recomputed.** Counting one event twice corrupts that day
permanently and silently - there is no recomputation pass that would fix it. Two things guarantee
it does not happen:

1. Batch idempotency short-circuits a replay before any of this runs.
2. Every `prepare*` method passes only genuinely newly-inserted events to the accumulator.

**If you add a channel or a counter, the pre-filter is not optional.**

The upsert is raw SQL with `LEAST`/`GREATEST`, because `firstActivityAt`/`lastActivityAt` need
comparison against the values already stored, which Prisma's query builder cannot express.

`deviceId` is part of the key, so a device reassigned mid-day produces two rows rather than one
row changing owner.

### Work-date attribution

The rollup is keyed on the employee's **local calendar date**, which only the workstation knows.
Attendance carries it; telemetry referencing an attendance session inherits it; everything else
falls back to the UTC date of its own timestamp - correct for a single-timezone office and never
worse than guessing.

A batch normally covers one day but can straddle midnight, and an agent returning from a long
offline stretch can carry a week. The unit of accumulation is therefore the **day**, not the batch.

## 7. Screenshots

`POST /api/v1/screenshots` - multipart, field name `file`, idempotent on `clientEventId`
(overwrite, not append). The image goes to `SCREENSHOT_STORAGE_DIR`; the row records the path.

`screenshotStorage.ts` is deliberately a two-function surface so an S3/Azure Blob backend can be
swapped in behind it. **The local filesystem is what blocks horizontal scaling** - with more than
one replica each holds a different subset and the dashboard 404s whichever it asks.

## 8. Policy and consent

- `GET /api/v1/policy` - the full document, never a diff. Created on demand if absent, with every
  column carrying a schema default, so an empty `create` seeds a complete policy.
- `POST /api/v1/consent` - idempotent on `(device, userSid, policyVersion)`. A version change
  re-prompts on the workstation.
- `GET /api/v1/heartbeat` - the agent's availability gate. It proves the credential is accepted
  **and** that the server can reach Postgres, neither of which an open socket implies. Returns the
  current `policyVersion` so the agent can detect a change without pulling the whole document.

## 9. Abandoned sessions - closing what the workstation never could

Every path that stamps an attendance `logoutTime` runs on the workstation: the agent observes the
lock, suspend or shutdown, and whatever it missed is repaired by its own recovery pass
(`TelemetryQueue.RecoverOpenAttendanceSessions`) at its next start. **Both require the machine to
still be there.**

Under scheduled load shedding it is not. Power drops mid-session, the agent gets no notice and
writes nothing, and the recovery pass runs only if and when that machine boots again with the agent
installed - after the weekend, after a reimage, or never. Until then the row reads `logoutTime =
NULL`, the reporting layer correctly renders that as "we do not know", and the day is a login with
no logout. **The server is the only participant still running, so it closes the row itself.**

`attendanceReaper.closeAbandonedSessions` runs on the maintenance schedule (`lib/scheduler.ts`,
every `ATTENDANCE_REAP_INTERVAL_SECONDS`, plus once at startup - the startup pass is the one that
clears the backlog an outage left behind). Three rules, in order:

| Rule       | Fires when                                                                                               | Stamps                           | `endReason` |
| ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------- |
| Superseded | A later login by the same user on the same workstation exists                                            | `min(last evidence, that login)` | `Recovered` |
| Abandoned  | The device has been silent **and** the row has not advanced, both for `ATTENDANCE_ABANDON_AFTER_SECONDS` | last evidence                    | `PowerLoss` |
| Ceiling    | The row has not advanced for `ATTENDANCE_MAX_OPEN_SECONDS`, however healthy the device                   | last evidence                    | `Recovered` |

Rule 1 is evidence, not a timeout, so it needs no waiting - and it is the common case after an
outage, because the machine comes back and opens a fresh session while the dead one is still open.
Rule 2 needs _both_ halves: a device still checking in has a live agent that will close its own
session, and a row whose totals are still growing belongs to somebody at their desk.

**Last evidence, never `now`.** A session that ended when the power went did not run until a sweep
noticed it; stamping the discovery time would add the length of the blackout to the working day. It
is the best of `loginTime + totalActiveSeconds + totalIdleSeconds`, the latest activity-log
`endTime`, and the latest metric `windowEndUtc` - all workstation clocks, clamped into
`[loginTime, now]`. **`updatedAt` is deliberately not among them**: it records when the row reached
_this server_, and a queue drained after an outage writes rows hours after the presence they
describe.

**Every close here is reversible.** It is written with `logoutSource = Server`, and the ingest guard
lets any later agent report overwrite it - a laptop that ran on battery through the blackout reports
the session still open, and the row reopens. The writes are guarded `updateMany ... WHERE
logoutTime IS NULL`, the same predicate ingest uses, so a sweep and an agent's real close racing
each other always resolve in the agent's favour without a lock between them.

`ATTENDANCE_ABANDON_AFTER_SECONDS` defaults to 45 minutes against the agent's own 14
(`AgentCadence.AttendanceStale`). The agent can afford the shorter window because it runs on the
workstation, where silence means the host really stopped; the server is behind the network too, and
an outage that kills the workstations kills the router with them.

Each job takes a Postgres **transaction-scoped** advisory lock (`pg_try_advisory_xact_lock`), so
several instances can run the schedule and only one sweeps. Transaction-scoped, not session-scoped:
Prisma is pooled, so consecutive queries can land on different backends and a session lock taken by
one would be unreleasable by the other. Set `MAINTENANCE_JOBS_ENABLED=false` to run an instance that
serves traffic and sweeps nothing.

---

## Failure modes

| Symptom                                   | Likely cause                                                             | Check                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Attendance day with a login and no logout | Row still open - workstation gone, sweep not yet run                     | `SELECT * FROM attendance_sessions WHERE "logoutTime" IS NULL`; see section 9                                            |
| A logout that looks too early             | Server-inferred close; the agent had reported nothing since              | `logoutSource = 'Server'` - it is corrected when the machine syncs                                                       |
| A logout that keeps reappearing as null   | Agent legitimately reporting the session still open after a server close | Expected: only `logoutSource = 'Agent'` is final                                                                         |
| 400 on every batch of one channel         | Wire contract drift on that channel                                      | Response `details[]` names the field; [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) |
| 413                                       | Batch over `JSON_BODY_LIMIT`                                             | Agent halves and retries automatically; only act if a _single_ event cannot fit                                          |
| 429                                       | One agent in a retry loop                                                | Limits are per device - a healthy fleet never hits them                                                                  |
| Totals too high                           | An event counted twice into the rollup                                   | A `prepare*` method missing its existing-id pre-filter                                                                   |
| Totals too low / flat                     | Device unassigned, or events rejected                                    | Devices screen; then `service-*.log` for rejections                                                                      |
| Numbers move on refresh but not live      | Signalling only - data is fine                                           | [realtime.md](realtime.md)                                                                                               |
| Duplicate-looking rows                    | Expected for attendance/alert upserts                                    | Same key, updated in place                                                                                               |

---

## Related

- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - hops 6-10 in context
- [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) - the wire format is shared
- [../reference/agent-api.md](../reference/agent-api.md) - endpoint reference
- [../reference/data-model.md](../reference/data-model.md) - the tables written here
- [reporting.md](reporting.md) - what reads the rollup
- [../agent/architecture.md](../agent/architecture.md) - the client side of this contract
