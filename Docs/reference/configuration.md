# Configuration reference

Two layers, changed in different ways and at different speeds.

| Layer       | Where                                 | Changed by                       | Takes effect         |
| ----------- | ------------------------------------- | -------------------------------- | -------------------- |
| Environment | `Backend/.env`, `Frontend/.env.local` | Editing a file and restarting    | On restart           |
| Policy      | `policies` table                      | An admin, on the Settings screen | Next agent heartbeat |

**Prefer policy.** Anything an operator might reasonably want to change belongs there, not in an
environment variable that needs a redeploy.

`Policy.browserSummaryScheduleTimeLocal` controls when the backend folds the previous work date's
raw browser visits into `browser_daily_summaries`. It is edited on the Settings screen as `HH:mm`
and uses the backend server's local clock, so configure it outside the organization's working
hours. The scheduler itself checks every minute and uses a database advisory lock when multiple
backend instances are running.

---

## Backend environment

Validated by Zod at startup in `Backend/src/config/env.ts`. **The process refuses to start on an
invalid value**, naming the variable.

### Core

| Variable             | Default                 | Notes                                                                                                                      |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `PORT`               | `5000`                  |                                                                                                                            |
| `NODE_ENV`           | `development`           | `development` \| `production` \| `test`                                                                                    |
| `DATABASE_URL`       | **required**            |                                                                                                                            |
| `BETTER_AUTH_SECRET` | **required**            | Min 16 characters                                                                                                          |
| `BETTER_AUTH_URL`    | `http://localhost:3000` |                                                                                                                            |
| `FRONTEND_URL`       | `http://localhost:3000` | The CORS origin, and the base of emailed password reset links                                                              |
| `PUBLIC_BASE_URL`    | `http://localhost:5000` | Builds `remoteUri` in the screenshot response. The agent only logs it, so it need not be publicly resolvable - just stable |
| `APP_TIME_ZONE`      | `UTC`                   | IANA zone the organization works in, for example `Asia/Dhaka`. See [Time zone](#time-zone). Invalid values fail startup    |

### Secrets

| Variable              | Default        | Notes                                                                                                                               |
| --------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DEVICE_TOKEN_PEPPER` | dev-only value | **The server refuses to start in production if this is still the default.** Changing it invalidates **every** issued device API key |

### <a id="trust_proxy"></a>Deployment topology

| Variable      | Default | Notes                                                                            |
| ------------- | ------- | -------------------------------------------------------------------------------- |
| `TRUST_PROXY` | `false` | Proxy count, or a value Express understands (`loopback`, a CIDR, `true`/`false`) |

**This must match reality.**

| Deployment                       | Value   |
| -------------------------------- | ------- |
| Exposed directly                 | `false` |
| Behind one reverse proxy         | `1`     |
| Behind a CDN in front of a proxy | `2`     |

Too low behind a proxy: every request appears to come from the proxy, so the per-IP backstop
collapses onto one bucket and the whole office is limited together. Too high, or `true` with no
proxy: clients can forge `x-forwarded-for` and dodge limits entirely.

### Rate limits (per minute)

| Variable                             | Default | Keyed by                  |
| ------------------------------------ | ------- | ------------------------- |
| `RATE_LIMIT_ENROLL_PER_MIN`          | `10`    | MachineGuid from the body |
| `RATE_LIMIT_INGEST_PER_MIN`          | `200`   | Device row id             |
| `RATE_LIMIT_SCREENSHOT_PER_MIN`      | `60`    | Device row id             |
| `RATE_LIMIT_UNAUTHENTICATED_PER_MIN` | `3000`  | IP, pre-auth backstop     |

One agent syncs six channels plus a heartbeat every couple of minutes, so 200/min is orders of
magnitude above normal and exists only to contain an agent stuck in a retry loop.

**Counters are per process.** With N replicas the effective limit is N times these values.

### Ingest

| Variable                                 | Default | Notes                                                                                                                                                                  |
| ---------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JSON_BODY_LIMIT`                        | `2mb`   | The **ceiling**. The agent packs to 900 KB; the headroom absorbs estimate error. Do not equalize them                                                                  |
| `INGEST_MAX_BATCH_EVENTS`                | `500`   | Abuse bound. The _operational_ size is `syncMaxBatchSize` (100). Deliberately several times higher so an agent that has not picked up a lowered policy is not rejected |
| `INGEST_TRANSACTION_TIMEOUT_MS`          | `15000` | Stops a wedged transaction holding locks indefinitely                                                                                                                  |
| `INGEST_BATCH_RETENTION_DAYS`            | `7`     | Must outlive the agent's retry window; after that the ledger row can never be consulted                                                                                |
| `DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS` | `60`    | Throttles `lastSeen` writes. Lower means write amplification on the hottest table                                                                                      |

### Maintenance jobs

Server-side housekeeping the request path cannot do for itself - see
[../backend/ingest.md](../backend/ingest.md) section 9. Every job takes a Postgres advisory lock, so
these are safe to leave enabled on every replica.

| Variable                              | Default | Notes                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAINTENANCE_JOBS_ENABLED`            | `true`  | Set `false` for an instance that serves traffic but sweeps nothing                                                                                                                                                                                                                                         |
| `ATTENDANCE_REAP_INTERVAL_SECONDS`    | `300`   | How often abandoned attendance sessions are closed. Also runs once at startup                                                                                                                                                                                                                              |
| `ATTENDANCE_ABANDON_AFTER_SECONDS`    | `2700`  | **The load-shedding knob.** How long a workstation must be silent _and_ its session unchanged before the server infers an end. Against the agent's own 14 minutes: the agent only has to trust the host, the server has to trust the network too, and an outage takes out the router with the workstations |
| `ATTENDANCE_MAX_OPEN_SECONDS`         | `57600` | Hard ceiling on an open session however healthy the device. Sized above the longest plausible working day so it can never truncate a real one                                                                                                                                                              |
| `ATTENDANCE_REAP_MAX_SESSIONS`        | `500`   | Sessions examined per sweep. Bounds the first pass after a long outage; the remainder is picked up next interval                                                                                                                                                                                           |
| `ATTENDANCE_REAP_TIMEOUT_MS`          | `30000` | A sweep holds the advisory lock for its duration, so a wedged one must not block every later one                                                                                                                                                                                                           |
| `INGEST_BATCH_PRUNE_INTERVAL_SECONDS` | `86400` | How often the batch ledger is pruned to `INGEST_BATCH_RETENTION_DAYS`                                                                                                                                                                                                                                      |
| `RETENTION_JOB_INTERVAL_SECONDS` | `86400` | How often the retention sweep enforces each organization's `retentionDays` |
| `RETENTION_BATCH_SIZE` | `500` | Rows removed per statement (max 1000, the S3 DeleteObjects limit) |
| `RETENTION_MAX_BATCHES_PER_TABLE` | `100` | Batches per table per organization per sweep; backlog finishes on later sweeps |
| `RETENTION_JOB_TIMEOUT_MS` | `600000` | Ceiling on one sweep; it holds the advisory lock meanwhile |

### Storage and database

| Variable                 | Default                 | Notes                                                                                                                     |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SCREENSHOT_STORAGE_DIR` | `./storage/screenshots` | **Local storage is what blocks horizontal scaling** - each replica holds a different subset                               |
| `SCREENSHOT_STORAGE_PROVIDER` | `local` | `s3` in production. The AWS deployment pins it; see [../operations/aws-ec2-deployment.md](../operations/aws-ec2-deployment.md) |
| `SCREENSHOT_S3_BUCKET` | - | Required when the provider is `s3`. Credentials come from the SDK default chain: the EC2 instance role on AWS |
| `SCREENSHOT_S3_REGION` | `us-east-1` | Bucket region |
| `DATABASE_POOL_MAX`      | `10`                    | Burst tolerance, not parallelism. Raise if requests queue behind the pool; divide the database's ceiling between replicas |

### Email and password recovery

See [../backend/password-recovery.md](../backend/password-recovery.md). The four EmailJS
credentials are all-or-nothing; a partial set fails startup.

| Variable | Default | Notes |
| --- | --- | --- |
| `EMAILJS_SERVICE_ID` | - | EmailJS service |
| `EMAILJS_PASSWORD_RESET_TEMPLATE_ID` | - | Recovery email template |
| `EMAILJS_PUBLIC_KEY` | - | Account public key |
| `EMAILJS_PRIVATE_KEY` | - | Account private key; required for server-side sends |
| `EMAILJS_TIMEOUT_MS` | `10000` | Abort bound on one send |
| `PASSWORD_RESET_EMAIL_TRANSPORT` | `server` | `server` sends with `@emailjs/nodejs`. `browser` makes the dashboard send with `@emailjs/browser`; see section 6 |
| `APP_NAME` | `CENTRIX` | Rendered as `{{app_name}}` |
| `PASSWORD_RESET_TTL_MINUTES` | `30` | Reset token lifetime, max 1440 |

### Process lifecycle

| Variable | Default | Notes |
| --- | --- | --- |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Drain budget after SIGTERM/SIGINT before a forced exit. Keep it below the orchestrator's grace period (compose `stop_grace_period` is 30s) |

## Frontend environment

| Variable                         | Read by              | Notes                                     |
| -------------------------------- | -------------------- | ----------------------------------------- |
| `MONITORING_API_URL`             | Next.js **server**   | May be an internal hostname               |
| `NEXT_PUBLIC_MONITORING_API_URL` | **Browser** (socket) | Must be reachable from the user's machine |
| `NEXT_PUBLIC_APP_TIME_ZONE`      | Browser and server   | Display zone. Must equal `APP_TIME_ZONE`. Inlined at build time |

Separate on purpose. Setting only the first leaves the socket pointed at `http://localhost:5000`
from the user's browser.

## Agent install-time config

`%ProgramData%\Centrix\agent.config.json`, written by `Deploy-Agent.ps1`.

| Field               | Notes                                            |
| ------------------- | ------------------------------------------------ |
| `serverUrl`         | The service refuses to start without a valid one |
| `enrollmentToken`   | Org-wide; traded once for a device API key       |
| `allowInsecureHttp` | Permits a plain-HTTP `serverUrl`. Test only      |

---

## <a id="policy-fields"></a>Policy fields

One row per organization in `policies`. `GET /api/v1/policy` returns the full document.
Editing any field increments `version`, which triggers a policy fetch **and** a fresh consent
prompt on every agent.

Defaults live in three places that must agree: the Prisma column default, the C# record default in
`AgentPolicy.cs` (what the agent runs on before its first fetch), and the pagination fallbacks in
`Backend/src/modules/report/pagination.ts`.

### Feature switches

| Field                   | Default |
| ----------------------- | ------- |
| `attendanceEnabled`     | `true`  |
| `activityEnabled`       | `true`  |
| `appSessionEnabled`     | `true`  |
| `browserMonitorEnabled` | `true`  |
| `screenshotEnabled`     | `true`  |
| `usbEnabled`            | `true`  |
| `alertEnabled`          | `true`  |
| `realtimeEnabled`       | `true`  |

`screenshotEnabled` defaults on **for testing** and is expected to be turned off before publish.

`realtimeEnabled` off falls the fleet back to poll-only behaviour with no redeploy and no data
loss - the HTTP paths are the system of record either way. A safe switch to flip under load.

### Collection

| Field                              | Default | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idleThresholdSeconds`             | `300`   | 5 minutes                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `appSessionPollSeconds`            | `1`     | Bounds how quickly a change of application is noticed, **not** how time is measured - durations are wall-clock differences, and idle boundaries are back-dated to the last real input. Raising it does not save meaningful CPU (a tick is a handful of Win32 calls) and does lose every application focused for less than one interval.                                                                                                               |
| `browserUiaTimeoutMs`              | `500`   | UI Automation read timeout                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `browserMaxRetryAttempts`          | `3`     | Extra address-bar reads allowed on consecutive ticks after a window changes, for browsers still painting. Beyond the budget the browser is left alone for 5 minutes, then retried.                                                                                                                                                                                                                                                                    |
| `browserUrlRefreshSeconds`         | `10`    | **The agent's main CPU dial.** How long a focused browser may sit on one page before its address bar is re-read. A page change is picked up immediately - a browser cannot navigate without changing its window title - so this only bounds navigation between two pages that share a title. Range 1-300; at 1 it is a cross-process UI Automation call every tick on every machine with a browser open, which is the behaviour it exists to prevent. |
| `screenshotIntervalSeconds`        | `600`   |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `screenshotJpegQuality`            | `70`    |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `usbReconciliationIntervalSeconds` | `5`     |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `usbAlertOnInsertion`              | `false` |                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Alerts

| Field                      | Default | Notes                                                                         |
| -------------------------- | ------- | ----------------------------------------------------------------------------- |
| `alertIdleEnabled`         | `true`  |                                                                               |
| `alertIdleNormalSeconds`   | `1800`  | 30 min                                                                        |
| `alertIdleModerateSeconds` | `2700`  | 45 min                                                                        |
| `alertIdleSevereSeconds`   | `3600`  | 60 min                                                                        |
| `alertIdleRenotifySeconds` | `900`   |                                                                               |
| `alertBlacklistEnabled`    | `true`  |                                                                               |
| `alertOutsideWorkingHours` | `false` | Desktop notifications are suppressed outside working hours unless this is set |

Escalation reuses one `clientEventId`, so an escalating incident is one row and one counted alert.

### Sync

| Field                        | Default | Notes                                                                                                                                                                                                           |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `syncBatchIntervalSeconds`   | `120`   |                                                                                                                                                                                                                 |
| `syncMaxBatchSize`           | `100`   | **The main lever on peak server cost.** A fleet of 100 draining a backlog together multiplies this. Capped in the DTO at `INGEST_MAX_BATCH_EVENTS` so an admin cannot configure batches the server would reject |
| `syncMinRetryBackoffSeconds` | `5`     |                                                                                                                                                                                                                 |
| `syncMaxRetryBackoffSeconds` | `120`   |                                                                                                                                                                                                                 |

### Presence

| Field                      | Default | Notes                                                                                                                             |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `presenceHeartbeatSeconds` | `30`    | A device is `live` if heard from within this x **2.5**. The grace means one dropped frame does not flip a healthy machine offline |

### Dashboard read path

| Field                | Default | Ceiling |
| -------------------- | ------- | ------- |
| `logPageSize`        | `50`    | 500     |
| `screenshotPageSize` | `12`    | 60      |

Separate settings on purpose (AD-13): a page of log rows is a few kilobytes of JSON, a page of
screenshots is that many full-size JPEGs the browser downloads and decodes.

### Retention

| Field                      | Default |
| -------------------------- | ------- |
| `retentionDays`            | `90`    |
| `undeliveredRetentionDays` | `30`    |

### <a id="time-zone"></a>Time zone

Timestamps are stored, transported and compared as UTC, always. `APP_TIME_ZONE` (backend) and
`NEXT_PUBLIC_APP_TIME_ZONE` (dashboard) only decide how a person reads them. Set both to the same
IANA zone; the deploy `.env` sets them from one `APP_TIME_ZONE` value.

| What follows the zone | Detail |
| --- | --- |
| Clock times and dates on every screen | Rendered in the zone, not the viewer's laptop or the server's |
| A bare report date (`startDate=2026-08-15`) | The local calendar day: for `Asia/Dhaka`, 18:00 UTC the evening before until 17:59:59.999 UTC |
| "Today" | Starts at local midnight, so the overview no longer shows yesterday for the first hours of a Dhaka day |
| Clock times in PDF reports | Printed in the zone, with the zone named in the "Generated" stamp |
| "Late night" in the burnout score | 20:00-05:00 local time |
| `reportSummaryScheduleTimeLocal` | Matched against the local clock in the zone |
| Fallback `workDate` for telemetry with no attendance session | The local date of its timestamp |

A `workDate` itself is the workstation's own local date, taken from the agent, and is never
shifted. The agent's machines and `APP_TIME_ZONE` should be in the same zone for one office.
`NEXT_PUBLIC_*` is inlined at build time, so changing the zone means rebuilding the dashboard image
(`./deploy/scripts/deploy.sh`), not just restarting it.

### Working hours

| Field                    | Default |
| ------------------------ | ------- |
| `workingHoursStartLocal` | `08:00` |
| `workingHoursEndLocal`   | `17:00` |
| `workingDays`            | Mon-Fri |

`workingDays` is a Postgres `text[]` - a real array column, not a serialized document.

---

## Adding a setting

1. **Should it be policy or environment?** If an operator might change it, policy.
2. Policy: add the column with a default in `schema.prisma`, mirror the default in `AgentPolicy.cs`,
   **add it to `PolicyForm.tsx`** - a field missing there is invisible to admins and stays at its
   default forever, which looks exactly like the feature not working.
3. Environment: add it to `config/env.ts` **with a comment saying what breaks at the wrong value**,
   and to `.env.example`.
4. Update this document in the same commit.

---

## Related

- [../backend/security.md](../backend/security.md) - how the limits are keyed
- [../operations/backend-deployment.md](../operations/backend-deployment.md) - what changes per deployment
- [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) - section 6, policy
- [data-model.md](data-model.md) - the `policies` table
