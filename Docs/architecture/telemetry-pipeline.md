# The telemetry pipeline

One event, followed from the moment it is observed to the moment it changes a number on a
manager's screen. Ten hops, each with its own failure behaviour.

When telemetry is missing, the question is always _which hop dropped it_. This document is the
map for answering that; [../operations/diagnostics.md](../operations/diagnostics.md) is the
procedure for walking it with a real event id.

```
 [1] collector observes                       Agent.Host, user session
 [2] MonitoringOrchestrator builds an event   ClientEventId assigned here
 [3] HostIpcClient -> IpcServer               named pipe, length-prefixed JSON
 [4] TelemetryQueue.Enqueue                   SQLite row, sent_utc = NULL     <-- durable
 [5] SyncWorker packs a batch                 MaxBatchSize, MaxRequestBytes
 [6] POST /api/v1/events/{channel}            device API key
 [7] ingestService.prepare                    dedup + categorize, outside the transaction
 [8] one transaction                          rows + rollup + batch ledger    <-- durable
 [9] acknowledgedEventIds -> MarkSent         only confirmed ids
[10] broadcastTelemetryIngested               dashboards move their totals
```

---

## Hop by hop

### [1]-[2] Collection

`Agent.Host` samples the foreground window, idle state, input counts and browser URL on the
interval policy specifies. `MonitoringOrchestrator` turns observations into typed event records
and assigns each a **`ClientEventId`** - a client-generated GUID that is the deduplication key
for the entire rest of the pipeline.

Source: `Windows Software_v3/src/Agent.Host/Services/MonitoringOrchestrator.cs`,
`Windows Software_v3/src/Agent.Host/Collectors/`.

**Failure behaviour:** if the host is not running, nothing is collected in that session and
there is no record that anything was missed. The service's `HostSupervisorWorker` exists to make
this window short. A host that crash-loops is the one failure in this pipeline that is silent
from the server's point of view - the device still heartbeats and still syncs USB events from
the service, so it looks healthy while collecting nothing.

### [3] Over the pipe

`HostIpcClient` sends length-prefixed JSON over the named pipe `Global\EmployeeMonitor.Agent`;
`IpcServer` receives it in the service.

**Screenshots do not travel this way.** The host writes the JPEG into the shared spool directory
and sends only the _file path_. A multi-megabyte frame every ten minutes would otherwise
monopolise a pipe that time-sensitive activity events share.

Source: `Windows Software_v3/src/Agent.Core/Ipc/`,
`Windows Software_v3/src/Agent.Service/Ipc/IpcServer.cs`.

**Failure behaviour:** if the pipe is down the host buffers in memory and retries. Events
observed while the service is stopped are lost - the host holds nothing durable by design.

### [4] The offline queue - first durability point

`TelemetryQueue.Enqueue` writes a row to SQLite (WAL mode) with `sent_utc = NULL` and
`attempts = 0`. **This is the first point at which an event survives a crash.**

Source: `Windows Software_v3/src/Agent.Core/Storage/TelemetryQueue.cs`.

Collection never waits on the network. A workstation that boots with no connectivity runs on its
cached policy, queues locally, and drains when the network returns.

### [5] Batching

`SyncWorker` takes up to `MaxBatchSize` events per channel per cycle (policy
`syncMaxBatchSize`, default 100), then `BackendClient.PackIntoRequests` splits them into
requests under `MaxRequestBytes` (900 KB), measured on the **encoded** JSON.

Channels are drained **sequentially**, chunks sequentially, screenshots one at a time. There is
no concurrency anywhere in the upload path - a hundred agents recovering from an outage must not
arrive as a thundering herd.

Source: `Windows Software_v3/src/Agent.Service/Workers/SyncWorker.cs`,
`Windows Software_v3/src/Agent.Service/Backend/BackendClient.cs`.

### [6] The request

`POST /api/v1/events/{channel}` with `Authorization: Bearer <device API key>`. Six channels:
`attendance`, `activity-metric`, `activity-session`, `browser-activity`, `usb-event`, `alert`.

Full contract in [../reference/agent-api.md](../reference/agent-api.md).

**Failure behaviour is three-way, and the distinction matters more than anything else in this
document:**

| Outcome                               | Means                                           | Agent does                                                 |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Acknowledged                          | Stored                                          | Marks those ids sent                                       |
| **Rejected** (4xx)                    | The server will refuse this identically forever | Increments the event's attempt counter; drops it after 5   |
| **Transient** (network, timeout, 5xx) | The data is fine, the server is not             | Backs off exponentially and retries; **counter untouched** |

Collapsing rejected and transient would mean a week-long outage aged out perfectly good data -
the exact opposite of what an offline queue is for.

A 413 is treated as recoverable: the chunk is halved and retried until it fits. Only a single
event that still will not fit is unsendable.

### [7] Preparation - deliberately outside the transaction

`ingestService.prepare()` runs before any transaction opens. It:

1. Reads which of the incoming ids are **already stored** on this channel.
2. Resolves `workDate` for each event, inheriting the attendance session's local calendar date
   where one exists and falling back to the UTC date of the event's own timestamp.
3. Re-derives `productivityTag` from the organization's category rules - the agent's tag can be
   a policy version behind, so the server's answer wins whenever a rule matches.
4. Accumulates the rollup deltas, counting **only genuinely new events**.

Doing this work before the transaction is what keeps lock hold time to the inserts alone. With
100 agents syncing on the same interval, that gap is the difference between contention and none.

Source: `Backend/src/modules/ingest/ingestService.ts`.

### [8] One transaction - second durability point

Three writes commit together or not at all:

1. The telemetry rows (`createMany` with `skipDuplicates`, or `upsert` for attendance and alerts).
2. The **daily rollup** increment.
3. The **batch ledger** row.

The rollup commits with the rows that produced it. Were they separable, a crash between them
would leave a day permanently miscounted with nothing to detect it. The ledger is written last
and inside the same transaction, so it can never claim a batch that did not land.

### Two layers of idempotency

The agent's queue is at-least-once: a batch that committed but whose HTTP response was lost is
resent **verbatim**. Two layers absorb that.

| Layer | Key                                                                                      | Catches                                                                                              |
| ----- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Batch | `ingest_batches(deviceId, batchId)` + a hash of the sorted canonical full event contents | A whole fleet replaying after an outage - answered from the ledger without touching telemetry tables |
| Event | Unique `clientEventId` per channel                                                       | A retry that repacked events into a different batch, or an agent predating batch ids                 |

If a `batchId` recurs with _different_ contents, the ledger is ignored and the batch is processed
on its merits - trusting the ledger there would silently discard real telemetry.

This content check is required for revisioned attendance. The agent keeps the same
`clientEventId` while it rewrites one local attendance row, so an open snapshot and a later
lock-closing snapshot must not be considered the same batch merely because their event ids match.

**Layer 2 is also what makes the rollup exact.** Counters are incremented, never recomputed, so
an already-stored event must contribute nothing.

### [9] Acknowledgement

The response carries `acknowledgedEventIds` - a per-event answer, not a batch status. The agent
marks acknowledged rows as sent locally. A later attendance rewrite clears that sent marker and
queues the same session again with a higher `revision`.
`TelemetryQueue.MarkSent` marks **only** those ids. `RetentionWorker` deletes marked rows later,
which is what "delete local copies only after successful synchronization" means in practice.

### [10] Signalling

After the commit, `broadcastTelemetryIngested` emits on the `/dashboard` namespace carrying the
**delta** this batch produced - never absolute values, never the rows.

Deltas are what make it safe to apply blind: a screen showing any date range, filter or employee
subset can add what just arrived and still be correct. `eventCount` is zero for a replay, so a
replay moves nobody's numbers.

A failure here cannot fail the ingest. The data is already durable; the worst case is a dashboard
whose numbers wait for its next refresh.

Source: `Backend/src/realtime/index.ts`, `Frontend/src/components/RealtimeProvider.tsx`.

---

## Where an event can actually be lost

In order of likelihood, and each one is checkable:

| #   | Loss                                                   | Detectable by                                                           |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | Host not running - nothing observed                    | Device online but no `activity-session` rows; check `host-s*.log`       |
| 2   | Observed but service down - in-memory buffer discarded | Gap in `activity_sessions` matching a service outage in `service-*.log` |
| 3   | Poison event dropped after 5 rejections                | `error`-level line in `service-*.log` naming the event id               |
| 4   | Aged out of the queue by retention                     | `RetentionWorker` line; only after `retentionDays`                      |
| 5   | Never attributed to a person                           | Row exists but device is still on the "Unassigned Devices" placeholder  |

**#5 is the one that looks like data loss but is not.** An unassigned device's telemetry is
stored correctly and simply never reaches per-employee reports. Check the Devices screen first.

Everything else in the pipeline is covered by retry, idempotency, or both.

---

## Related

- [system-overview.md](system-overview.md) - the tiers this path crosses
- [cross-tier-contracts.md](cross-tier-contracts.md) - the couplings along it
- [../backend/ingest.md](../backend/ingest.md) - hops 6-10 in detail
- [../agent/architecture.md](../agent/architecture.md) - hops 1-5 in detail, section 4 for the durability table
- [../operations/diagnostics.md](../operations/diagnostics.md) - how to walk this with a real event id
