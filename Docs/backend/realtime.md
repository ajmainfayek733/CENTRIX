# Realtime - Socket.IO signalling

Source: `Backend/src/realtime/`.

| File | Responsibility |
|---|---|
| `index.ts` | Server setup, both namespaces, handshake auth, emit helpers |
| `events.ts` | Event names, room helpers, payload types - **the shared contract** |
| `presence.ts` | In-memory device presence registry |
| `ticket.ts` | Short-lived signed tickets for browser handshakes |

---

## 1. The rule

**Signalling only. Never data, never availability.**

The socket carries "something changed", presence, and commands. It never carries telemetry or
rows. Dashboards receive a hint and call `router.refresh()`; the numbers still come from HTTP.

Neither side treats an open connection as proof the backend is working. A socket survives an
unplugged cable for minutes and says nothing about whether the server can reach Postgres. The
availability oracles are `GET /api/v1/heartbeat` (agents) and `GET /health` (load balancers).

**Consequence:** `realtimeEnabled` can be turned off in policy and the fleet falls back to
poll-only behaviour with no redeploy and no data loss. It is a safe switch to flip under load.

## 2. Two namespaces

| | `/agents` | `/dashboard` |
|---|---|---|
| Credential | `auth.apiKey` - device API key | `auth.ticket` (browser) or `auth.token` (server-to-server) |
| Verified by | Same HMAC lookup as `deviceAuth` | `verifyRealtimeTicket`, else Better Auth session |
| Joins rooms | `device:<id>` and `organization:<id>` | `organization:<id>` |

Handshake failures never leak a reason to the peer - the detail goes to the server log.

Transports are `['websocket', 'polling']`. The polling fallback is kept because office proxies
often mishandle websocket upgrades, and a degraded signalling channel is better than none.

### Why the browser uses a ticket

The dashboard session lives in an httpOnly cookie precisely so page scripts cannot read it. So
the browser cannot put the session token in a handshake. Instead the Next.js server exchanges the
cookie for a short-lived signed ticket (`POST /v1/dashboard/auth/realtime-ticket`) and the browser
holds only that.

The `token` field exists for server-to-server clients and tests that already hold a session
legitimately. **It is never used by the browser.** See
[../frontend/session-and-auth.md](../frontend/session-and-auth.md).

## 3. Events

| Direction | Event | Payload | Meaning |
|---|---|---|---|
| Agent -> server | `hello` | version, policy version | Connected, logged once |
| Agent -> server | `heartbeat` | `userPresent` | Proof of life |
| Server -> agent | `policy:updated` | `version` | Fetch policy, re-prompt consent |
| Server -> agent | `sync:force` | `reason` | Drain the queue now |
| Server -> agent | `device:deactivated` | - | Stop pushing, without waiting for a 403 |
| Server -> dashboard | `telemetry:ingested` | deltas + `workDates` | A batch landed |
| Server -> dashboard | `device:presence` | connected/live/userPresent/lastSeen | One device changed |
| Server -> dashboard | `device:presence-snapshot` | all devices + `maxSilenceMs` | Sent once on connect |
| Server -> dashboard | `policy:updated` | `version` | Another admin edited policy |
| Dashboard -> server | `device:force-sync` | `deviceId`, ack callback | Operator pressed the button |

Names and payload shapes are duplicated in `Frontend/src/lib/realtime.ts`. A mismatch is
**silent** - the emitter emits, nobody listens, live updates stop while every number stays correct
on refresh. See [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md).

### `telemetry:ingested` carries the aggregate, not a hint

The payload contains the **delta** the batch produced - twelve counters, all relative.

Deltas are what make it safe to apply blind: a screen showing any date range, filter or employee
subset can add what just arrived and still be correct. An absolute value for one
(day, device, employee) could not be folded into a range total without knowing what that key
already contributed.

`eventCount` is **zero for a replay**, so a replayed batch moves nobody's numbers. `workDates`
lets a screen showing one date ignore a backfill for another.

The work was done once at ingest; making every viewer recompute it was the cost this replaces.

## 4. Presence and liveness

Two different questions, tracked separately:

| Question | Answered by | Source |
|---|---|---|
| Would a command reach this agent right now? | `connected` | A socket exists |
| Is this workstation actually alive? | `live` | A heartbeat arrived recently |
| Is someone sitting at it? | `userPresent` | Last heartbeat's flag |
| When did it last talk to the server? | `lastSeen` | `devices.lastSeen`, HTTP-driven |

`live` = a heartbeat within `presenceHeartbeatSeconds` x **2.5**. The grace multiplier means a
single dropped or delayed frame - a GC pause, a busy uplink - does not flip a healthy workstation
to offline and back. Two missed beats is the threshold.

**Presence is per device, not per socket.** A reconnect that races its own disconnect must not
report the device as gone, so the registry only announces on the *last* socket leaving.

A dashboard receives a **snapshot on connect**, because devices that connected before this browser
did will not heartbeat again for up to a full interval - and until then the screen an operator
looks at first would show them all as offline. `userPresent` in the snapshot is `false`: it is not
tracked across reconnects, and the next heartbeat corrects it within one interval. Claiming a user
is present on no evidence would be worse.

The heartbeat writes `lastSeen` through the same throttled path the HTTP middleware uses, but the
**broadcast is not throttled**. The dashboard should tick on every heartbeat even when the database
write was collapsed - a broadcast is a few bytes to already-open sockets; a row update is not.

## 5. Force sync

`super_admin` only. Reported honestly: if the agent holds no socket the command **cannot** be
delivered now, and the ack says so rather than showing a success it cannot vouch for. The device
still syncs on its own interval.

## 6. Emit helpers

`broadcastPolicyUpdated`, `requestDeviceSync`, `notifyDeviceDeactivated`,
`broadcastTelemetryIngested`, `broadcastPresence` are the **only** supported way for the rest of
the server to publish.

All of them are no-ops before init and wrapped in `safeEmit`, so a realtime failure can never fail
the HTTP request that triggered it. The data is already committed by the time these run.

## 7. Scale

Single Node process, no Redis adapter (AD-08). At 30-100 devices one process holds every
connection comfortably. Running more than one instance would need the adapter; that is a
deployment change, and the emit helpers are the only places that would care.

---

## Failure modes

| Symptom | Likely cause | Check |
|---|---|---|
| Dashboard never updates live, refresh works | Event name drift, or `realtimeEnabled` off | Compare `events.ts` with `Frontend/src/lib/realtime.ts`; check policy |
| Handshake rejected | Bad ticket, expired ticket, or deactivated device | Server log - the reason is never sent to the peer |
| Totals become `NaN` | `RollupDeltaPayload` field present on one side only | Both definitions must carry the same twelve fields |
| Devices flap online/offline | `presenceHeartbeatSeconds` too low for the network | Grace is 2.5x; raise the interval |
| Everything offline right after opening a tab | Snapshot missing or failed | Server log at connect |
| Force sync always fails | Agent has no socket | Expected - it will sync on interval |
| Numbers correct on refresh, wrong live | A delta applied twice, or a non-delta emitted | Payload must be relative, never absolute |

---

## Related

- [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) - section 5, the duplicated contract
- [../frontend/live-updates.md](../frontend/live-updates.md) - the consumer
- [reporting.md](reporting.md) - `lastSeen` vs presence
- [ingest.md](ingest.md) - what triggers `telemetry:ingested`
