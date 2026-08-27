# Glossary

Terms that mean something specific in this system. Where a word is easy to confuse with a
near-neighbour, both are listed together.

---

**Activity session** - one interval of a single foreground application, or of being idle, locked,
asleep or disconnected. Not a login session. Table `activity_sessions`; the `type` enum decides
which kind it is.

**Agent** - the pair of Windows executables in `Windows Software_v3/`. Singular "the agent" means
both processes together; when the distinction matters, say **service** or **host**.

**Attendance session** - one Windows logon session, from `loginTime` to `logoutTime`. Carries the
`workDate`. Table `attendance_sessions`, keyed on `sessionId`.

**Batch id** - a uuid identifying one push of events. The key for the first layer of idempotency.
Optional on the wire; without it a replay still deduplicates per event, just more expensively.

**Channel** - one of the six telemetry streams: `attendance`, `activity-metric`,
`activity-session`, `browser-activity`, `usb-event`, `alert`. Also the URL segment in
`POST /api/v1/events/{channel}`.

**ClientEventId** - a uuid the *agent* generates for each event, before it is ever sent. The
deduplication key for the whole pipeline. Not a database primary key.

**Connected** vs **live** vs **online** - three different claims:

| Term | Means | Source |
|---|---|---|
| `connected` | A command sent right now would reach the agent | A socket exists |
| `live` | The workstation is actually alive | A heartbeat within `presenceHeartbeatSeconds` x 2.5 |
| "online now" | It authenticated to the API recently | `devices.lastSeen` |

They can disagree, and each is correct about a different thing. A socket outlives an unplugged
cable by minutes; `lastSeen` outlives a socket drop.

**Delta** - a relative change carried on `telemetry:ingested`. Never an absolute. Deltas can be
applied to a screen showing any date range or filter and stay correct.

**Device API key** - the per-device bearer credential, minted at enrollment. 32 random bytes,
stored DPAPI-protected on the workstation and as an HMAC on the server.

**Device id** - ambiguous, so watch the context:

| In | Means |
|---|---|
| `devices.deviceId` and enrollment | The Windows **MachineGuid** |
| `devices.id` and realtime payloads | The database row uuid |

**Enrollment token** - the **org-wide** secret in every install. Traded once per machine for a
device API key. Returned exactly once at organization creation.

**Host** - `EmployeeMonitor.Host.exe`, running in the interactive user session. Observes. Holds no
credential, opens no socket.

**Idempotency, layer 1 / layer 2** - batch-level (`ingest_batches`) and event-level (unique
`clientEventId`). Layer 1 saves work; layer 2 guarantees correctness.

**MachineGuid** - `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`. The device identity key.
Chosen over MAC address, which is spoofable and plural per machine.

**Placeholder employee** - the hidden "Unassigned Devices" record every organization has. New
devices park on it. Their telemetry is stored correctly but reaches no per-employee report.

**Poison event** - an event the server rejects identically every time. Dropped after 5 rejections
so it cannot block the queue behind it.

**Policy** - the full settings document for an organization, served whole and never as a diff. Its
`version` increments on every write, which triggers an agent re-fetch and a fresh consent prompt.

**Prepare / write split** - resolving lookups, categorization and deduplication *before* the ingest
transaction opens, so the transaction holds locks only for the inserts.

**Productive share** - `productiveSeconds / activeSeconds`, 0-100. Idle time is excluded from the
denominator.

**Rejected** vs **transient** - the distinction the whole sync durability model rests on:

| | Means | Effect on the attempt counter |
|---|---|---|
| Rejected (4xx) | The server will refuse this identically forever | Incremented; dropped after 5 |
| Transient (network, timeout, 5xx) | The data is fine, the server is not | **Untouched** |

**Replay** - a batch resent verbatim because its response was lost. Recognized from the ledger and
answered without redoing the work. Reported back as `replay: true`, and contributes
`eventCount: 0`.

**Rollup** - `daily_activity_rollups`. One row per employee per day per device, incremented at
ingest time. What every aggregate report reads.

**Service** - `EmployeeMonitor.Service.exe`, LocalSystem in session 0. Decides and persists. Owns
the database, the credential, policy and all backend traffic.

**Session 0** - the Windows session where services run. Has no desktop, so it cannot read window
titles, measure idle time, or capture the screen. The reason the agent is two processes.

**Signalling** - what the Socket.IO connection carries: "something changed", presence, commands.
Never telemetry, never proof of availability.

**Ticket** - a short-lived signed credential minted server-side so a browser can open a socket
without ever holding the session token.

**Unassigned** - a device still pointing at the placeholder employee. The most common cause of
"the agent is not working" that is not a bug.

**Work date** - the employee's **local** calendar date (`YYYY-MM-DD`), sent by the agent because
only the workstation knows its own timezone. Everything else on the wire is UTC.

---

## Related

- [../architecture/system-overview.md](../architecture/system-overview.md)
- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md)
- [data-model.md](data-model.md)
