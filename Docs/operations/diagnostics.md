# Diagnostics

Where the evidence is, and how to follow one event from a workstation to a dashboard.

---

## 1. Log locations

### Agent (workstation)

`%ProgramData%\Centrix\logs\`

| File | Written by | Contains |
|---|---|---|
| `service-<date>.log` | `Centrix.Service.exe` (SYSTEM) | Enrollment, policy fetches, sync cycles, rejections, retention sweeps, host supervision |
| `host-s<session>-<date>.log` | `Centrix.Host.exe` (user) | Collector activity, IPC sends, alert evaluation, screenshot capture |

File names are prefixed per writing process so two processes never share a handle. Files roll
daily and at 8 MB, and are pruned after 14 days by `RetentionWorker` running as SYSTEM.

Both processes **also** write to the Windows Event Log:

| Source | Process |
|---|---|
| `CentrixAgent` | Service |
| `CentrixHost` | Host |

**The files are what to collect for diagnosis.** The Event Log covers anything that fails before
the file sink can open - a bad config, a missing dependency, a permissions problem - and fleet
monitoring that already scrapes it.

> If `host-s*.log` does not exist at all, the host never started. That is the finding.

The `logs\` directory grants Users *write* but not modify, so a standard user can append but
cannot delete or truncate the agent's history.

### Backend

`stdout`/`stderr` via morgan (`combined` in production, `dev` otherwise) plus explicit
`console.error`/`console.warn`.

The error handler logs deliberately asymmetrically: **5xx with a stack**, 4xx as a one-line
warning. A 4xx is the API doing its job - a rejected batch, an oversized body - and printing a
stack for each one buries the 5xx that needs attention.

Useful prefixes to grep for:

| Prefix | Meaning |
|---|---|
| `ingest:` | Batch replay warnings, batch-id collisions |
| `realtime:` | Handshake failures, presence, emit failures |
| `deviceAuth:` | `lastSeen` write failures |
| `health:` | Database probe failure |
| `Unhandled Error:` | A 5xx with a stack |

### Frontend

Server-side: the Next.js process output. Route handlers log with a `logs/<feed>:` prefix.

Browser: the console. `console.error('Dashboard render failed:', error)` fires in the error
boundary.

**The digest.** When a user reports an error showing `Reference: <digest>`, that is Next's
server-side correlation id and the only thing tying their report to a specific server log line.
Ask for it.

### Database

```sql
-- Devices not heard from recently
SELECT "deviceName", "lastSeen", "isActive" FROM devices ORDER BY "lastSeen" ASC;

-- Devices parked on the unassigned placeholder
SELECT d."deviceName" FROM devices d
  JOIN employees e ON e.id = d."employeeId"
 WHERE e.status = 'placeholder';

-- Did a specific batch land?
SELECT * FROM ingest_batches WHERE "batchId" = '<batch id>';

-- What did a day roll up to?
SELECT * FROM daily_activity_rollups
 WHERE "employeeId" = '<id>' AND "workDate" = '2026-08-14';

-- Who viewed what
SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50;
```

### Agent-local SQLite

`%ProgramData%\Centrix\agent.db` - readable with any SQL client, because there are no
serialized-document columns anywhere in it.

```sql
-- Anything queued and not yet acknowledged
SELECT channel, COUNT(*) FROM telemetry_queue WHERE sent_utc IS NULL GROUP BY channel;

-- Events the server keeps refusing
SELECT * FROM telemetry_queue WHERE attempts > 0 ORDER BY attempts DESC;
```

A growing `sent_utc IS NULL` count with rising `attempts` means rejection (a contract problem). A
growing count with `attempts` at zero means the server is unreachable (a connectivity problem).
**That is the fastest way to tell those two apart.**

## 2. Tracing one event end to end

You need a `clientEventId`. Get it from the agent's queue, or from a row in the database.

| Hop | Where to look | Confirms |
|---|---|---|
| 1-2 Collected | `host-s*.log` around the timestamp | The host observed it |
| 3 Over the pipe | `host-s*.log` send line, `service-*.log` receive | IPC is healthy |
| 4 Queued | `SELECT * FROM telemetry_queue WHERE client_event_id = '<id>'` | It is durable on the workstation |
| 5-6 Sent | `service-*.log` sync cycle naming the batch | It left the machine |
| 6 Received | Backend log; a 400 names the field | The server accepted or rejected it |
| 8 Stored | `SELECT * FROM <channel table> WHERE "clientEventId" = '<id>'` | It is durable on the server |
| 8 Counted | `daily_activity_rollups` for that `(workDate, employeeId)` | It moved the totals |
| 9 Acknowledged | `sent_utc IS NOT NULL` in the agent queue | The loop closed |
| 10 Signalled | Browser console / network tab | The dashboard was told |

**Where it stops is the diagnosis.** The most common stopping points:

- Stops at hop 1 - the host is not running.
- Stops at hop 6 with a 400 - wire contract drift.
- Reaches hop 8 but not the rollup - the event was filtered as already-existing (correct for a
  replay) or the channel does not contribute to that counter (correct for attendance).
- Reaches hop 8 but nothing shows on screen - the device is unassigned.

Full context: [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md).

## 3. Reproducing the degraded-service behaviour

```bash
cd Frontend
npm run build
MONITORING_API_URL=http://127.0.0.1:5999 npx next start -p 3099
```

Expected: `/login` reports the service unavailable rather than rejecting valid credentials, and
`/overview` renders the shell with an outage card and **does not redirect**.

Re-run this after touching `api-client.ts`, `session.ts`, the dashboard layout, the error boundary
or the logs proxy. See [../frontend/resilience.md](../frontend/resilience.md).

## 4. Verifying the backend contract

```bash
cd Backend && npm test
```

An integration smoke test against the **real** database: enrollment, auth boundaries, per-channel
validation, column-level persistence, idempotency and the device kill switch. This is what catches
a broken wire contract before a fleet does.

## 5. Checking agent state on a workstation

```powershell
sc query CentrixAgent
Get-Process Centrix.Host -ErrorAction SilentlyContinue

cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Status
```

## 6. What to collect for a bug report

1. Which tier - result of `curl http://localhost:5000/health`.
2. The `Reference:` digest if the dashboard showed one.
3. From the affected workstation: `service-<date>.log` and `host-s*-<date>.log` covering the
   window, plus the queue counts from section 1.
4. Backend log lines for the same window.
5. The `clientEventId` of one affected event, and how far it got in the table in section 2.
6. Whether the device is assigned and active.

---

## Related

- [troubleshooting.md](troubleshooting.md) - symptom-indexed causes
- [../architecture/telemetry-pipeline.md](../architecture/telemetry-pipeline.md) - the path being traced
- [../reference/data-model.md](../reference/data-model.md) - the tables queried above
- [../agent/architecture.md](../agent/architecture.md) - section 11, agent logging
