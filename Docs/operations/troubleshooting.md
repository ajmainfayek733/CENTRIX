# Troubleshooting

Indexed by **symptom**, because that is what you have when something is wrong.

Each entry names the likely cause, what to check, and where the mechanism is documented. If the
symptom is "telemetry is missing", start at section 1 - it is the most common report and usually
not a bug.

Before anything else, establish which tier is failing:

```
curl http://localhost:5000/health          # 200 = API up AND Postgres reachable
                                           # 503 = API up, database unreachable
                                           # refused = API down
```

`/health` runs a real query rather than returning a constant, so a 200 means the server can
actually do work. See [diagnostics.md](diagnostics.md) for collecting logs.

---

## 1. "The agent is not reporting anything"

Work down this list in order. The first three are far more common than the rest.

| # | Check | If this is it |
|---|---|---|
| 1 | **Is the device assigned to an employee?** Devices screen - is it on "Unassigned Devices"? | Telemetry is being stored correctly but never reaches per-employee reports. Assign it. Not a bug. |
| 2 | **Is the device active?** Devices screen - deactivated devices get 403 on everything. | Reactivate. Note a deactivated device also gets 403 at re-enrollment, by design. |
| 3 | **Is the host process running?** Task Manager on the workstation - `EmployeeMonitor.Host.exe`. | The service can be perfectly healthy while collecting nothing. See section 2. |
| 4 | Is the service running? `sc query EmployeeMonitorAgent` | Nothing is queued or sent while it is stopped. |
| 5 | Is the queue draining? Check `service-<date>.log` for sync cycles. | Look for rejections or backoff - sections 3 and 4. |
| 6 | Did enrollment succeed? Look for the enrollment line in `service-*.log`. | A bad `serverUrl` or enrollment token in `agent.config.json`. |

**The most important distinction:** a device that appears **online** on the dashboard is proving
only that the *service* is authenticating. Attendance, activity sessions, idle state, browser
activity and screenshots all come from the **host**. A crash-looping host produces a device that
looks healthy and collects nothing.

## 2. A device is online but has no activity data

The host is not running, or is crash-looping.

- Check `host-s<session>-<date>.log` in `%ProgramData%\EmployeeMonitor\logs\`. If the file does
  not exist, the host never started.
- Check the Event Log source `EmployeeMonitorHost` for failures before the file sink could open.
- `HostSupervisorWorker` widens its relaunch interval to 5 minutes after 5 fast failures, so a
  crash loop looks like long silences rather than constant restarts.

USB events will still arrive throughout, because they come from the service. That asymmetry is the
signature of this failure.

## 3. One channel stopped, the rest are fine

Wire-contract drift on that channel.

- The backend returns 400 with `details[]` naming the field and the message. That is the diagnosis.
- Compare `Agent.Core/Contracts/TelemetryEvents.cs` with `Backend/src/modules/ingest/ingest.dto.ts`.
- See [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) section 1.

**Watch the queue.** A field rename poisons every event already queued under the old contract, not
just new collection. Those events are dropped after 5 rejections with an error-level log line
naming the id.

## 4. Everything stopped after a deploy

| Check | Cause |
|---|---|
| Every login fails opaquely | `express.json()` mounted before the Better Auth handler in `server.ts` |
| Server will not start, complains about a secret | `DEVICE_TOKEN_PEPPER` still the development default in production |
| Every agent gets 401 | The pepper was changed - this invalidates **every** device API key |
| Every request 400s with an env error | `config/env.ts` validation failed; the message names the variable |
| Dashboard shows nothing, API is up | `MONITORING_API_URL` wrong, or CORS `FRONTEND_URL` mismatch |

## 5. Rate limiting is hitting a healthy fleet

Almost always `TRUST_PROXY`.

| Deployment | Value |
|---|---|
| Exposed directly | `false` (default) |
| Behind one reverse proxy | `1` |
| Behind a CDN in front of a proxy | `2` |

Too low behind a proxy: every request appears to come from the proxy, so the per-IP backstop
collapses onto one bucket and the whole office is limited together. Too high, or `true` with no
proxy: clients can forge `x-forwarded-for` and dodge limits entirely.

Note that the *authenticated* limits are keyed per device, so a healthy fleet should never reach
them. A single agent hitting 429 repeatedly is an agent stuck in a retry loop.

## 6. Numbers are wrong

| Symptom | Cause | Where |
|---|---|---|
| Totals too high | An event counted twice into the rollup | A `prepare*` method missing its existing-id pre-filter - [../backend/ingest.md](../backend/ingest.md) section 6 |
| Totals too high after a replay | A non-delta emitted on `telemetry:ingested`, or `eventCount` not zero for replays | [../backend/realtime.md](../backend/realtime.md) section 3 |
| Totals become `NaN` live | `RollupDeltaPayload` field on one side only | [../frontend/live-updates.md](../frontend/live-updates.md) |
| Day totals double | Attendance seconds counted as well as activity sessions | Attendance must contribute dates only |
| Productive share looks wrong | Idle time in the denominator | It must be `productive / active` |
| A day is attributed to the wrong date | Work-date fallback used because the attendance row had not arrived | Expected for out-of-order batches; corrects on the next attendance push |
| Totals and timeline disagree | The timeline is one page; totals are the range | Not a bug |
| **Logout time equals login time** | The session was closed by attendance recovery, which used to stamp the logout at `login_time` | Check `endReason`: `Recovered` confirms it. Fixed - recovery now infers the logout from the row's own totals. [../agent/agent-core.md](../agent/agent-core.md) |
| A session shows zero duration but non-zero active seconds | Same cause - the duration came from recovery, the seconds from real collection | The seconds are the trustworthy half, and are what the repair below reconstructs from |
| An attendance row's totals went **backwards**, or a closed session reopened | An older snapshot of the session was delivered after a newer one | Should be impossible now: `revision` orders the reports and ingest drops any below the stored one. If it happens, check the row's `revision` against what the agent sent - a device stuck at `revision = 0` is running a build older than the counter and is still ordered by the old logout-based rules |
| **A day has a login and no logout** | The row is still open. The workstation that owned it stopped without closing it, and no sweep has closed it yet | Expected for up to `ATTENDANCE_ABANDON_AFTER_SECONDS` (45 min) after the machine goes quiet, and immediately resolved once the same user logs in again. Longer than that, see below |

**`endReason` tells you how much to trust a logout time, and `logoutSource` tells you who wrote
it.** `Logout`, `Shutdown`, `Lock` and `Sleep` were observed. `Recovered` and `PowerLoss` were
**inferred** - by the agent from the last totals it managed to persist, or by the server from the
last evidence it holds. `logoutSource = 'Agent'` means the workstation reported it and it is final;
`'Server'` means the row was abandoned and the reaper closed it, and the agent's own report will
overwrite that estimate whenever the machine comes back. A run of inferred rows means hosts are
dying rather than exiting: look for crashes, an upgrade that replaced the executable under a running
host, or - the usual answer on a load-shedding site - the power.

**A session that stays open past the threshold is a job that is not running.** Check for it:

```sql
SELECT "sessionId", "loginTime", "totalActiveSeconds" + "totalIdleSeconds" AS observed_seconds
FROM attendance_sessions
WHERE "logoutTime" IS NULL
ORDER BY "loginTime";
```

More than one row per currently-live workstation means the sweep is not happening. In order:
`MAINTENANCE_JOBS_ENABLED` is not `false`; the server log carries a `scheduler:` line at startup;
no `scheduler: attendanceReap failed` since. The sweep also runs once at startup, so a restart is a
valid way to force it. There is no manual repair to run - the sweep is the repair, it is
idempotent, and it fixes a backlog of any age. See
[../backend/ingest.md](../backend/ingest.md) section 9.

Rows written before the *agent* recovery fix carry `logoutTime = loginTime`. They can be repaired in
place, because the observed seconds on the row are the same data the fixed code uses:

```sql
UPDATE attendance_sessions
SET "logoutTime" = "loginTime" + make_interval(secs => "totalActiveSeconds" + "totalIdleSeconds")
WHERE "endReason" = 'Recovered'
  AND "logoutSource" IS NULL          -- pre-dates server-side closure; leave the reaper's work alone
  AND "logoutTime" = "loginTime"
  AND "totalActiveSeconds" + "totalIdleSeconds" > 0;
```

This corrects the attendance rows only. Rollup counters are incremented and never recomputed, so
anything already aggregated from them stays as it is.

**Rollup counters are incremented, never recomputed.** There is no repair pass - a double count is
permanent and silent. Treat any change to a `prepare*` method as touching accounting code.

## 7. Dashboard problems

| Symptom | Cause | Where |
|---|---|---|
| An API restart signs everyone out | The 5xx / 401 distinction collapsed | [../frontend/resilience.md](../frontend/resilience.md) - this was a real bug; re-verify after touching `session.ts` |
| Outage presented as "session expired" | 5xx classified as `ApiError` | Same |
| Blank page, no header or nav | Error escaped the boundary, or the layout threw | The layout catches `ApiUnavailableError` only |
| Live updates never arrive, refresh works | Event-name drift, or `realtimeEnabled` off | [../backend/realtime.md](../backend/realtime.md) |
| Socket never connects, pages fine | `NEXT_PUBLIC_MONITORING_API_URL` not reachable from the browser | It is deliberately separate from `MONITORING_API_URL` |
| Scrolling never loads more rows | `IntersectionObserver` rooted to the viewport, not the scroll container | [../frontend/live-updates.md](../frontend/live-updates.md) section 5 |
| Rows repeat or skip while scrolling | Cursor is not `(timestamp, id)` | [../backend/reporting.md](../backend/reporting.md) section 2 |
| Screenshot grid very slow | `screenshotPageSize` raised toward `logPageSize` | Separate settings on purpose (AD-13) |
| Screenshots 404 in the browser, files exist | Multiple API replicas with local screenshot storage | [backend-deployment.md](backend-deployment.md) section 3 |
| A nav link 403s on arrival | UI role mirror out of step with backend RBAC | `Frontend/src/lib/session.ts` |
| Overview slow and getting slower monthly | An aggregate query reading a log table | [../backend/reporting.md](../backend/reporting.md) section 1 |

## 8. Agent installation and update

| Symptom | Cause |
|---|---|
| Service refuses to start | No valid `serverUrl` or enrollment token in `agent.config.json` |
| Service refuses a plain-HTTP server | Expected - pass `-AllowInsecureHttp` for local testing only |
| Enrollment returns 401 | Wrong or rotated enrollment token |
| Enrollment returns 403 | The device was deactivated by an admin - reinstalling is not a way around it |
| USB events never appear, everything else works | The build was trimmed - trimming breaks `System.Management`'s reflective WMI types |
| A re-imaged machine lost its employee | It should not - re-enrollment is idempotent on MachineGuid. Check whether MachineGuid actually changed |
| Screenshots never upload | Multipart field name mismatch (`file`) - [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) section 3 |

## 9. Build and tooling

| Symptom | Cause |
|---|---|
| `WIX7015` | WiX v6+ requires the paid maintenance-fee EULA. Pin to 5.0.2 (AD-14) |
| `WIX6101` | WiX extensions not version-matched to the CLI |
| Node refuses to load `dist/` | `dist/package.json` CommonJS marker missing - `npm run build` writes it |
| `next dev` refuses to start | A dev server is already running in that directory; use `next start` on another port |
| MCP server fails on Windows | stdio entries need `cmd /c npx ...`; adding them via Git Bash mangles `/c` into `C:/` |

---

## When none of this matches

1. Establish the tier with `/health` and the browser console.
2. Collect logs as described in [diagnostics.md](diagnostics.md).
3. Walk the pipeline hop by hop with a real event id -
   [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) lists what can be
   lost at each one.
4. Check whether the change that introduced it crossed a tier boundary -
   [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md).

---

## Related

- [diagnostics.md](diagnostics.md) - logs, tracing, what to collect
- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - where data can be lost
- [../architecture/decisions.md](../architecture/decisions.md) - why things are the way they are
- [../reference/configuration.md](../reference/configuration.md) - every setting named above
