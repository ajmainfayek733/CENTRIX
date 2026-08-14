# Configuration reference

Two layers, changed in different ways and at different speeds.

| Layer | Where | Changed by | Takes effect |
|---|---|---|---|
| Environment | `Backend/.env`, `Frontend/.env.local` | Editing a file and restarting | On restart |
| Policy | `policies` table | An admin, on the Settings screen | Next agent heartbeat |

**Prefer policy.** Anything an operator might reasonably want to change belongs there, not in an
environment variable that needs a redeploy.

---

## Backend environment

Validated by Zod at startup in `Backend/src/config/env.ts`. **The process refuses to start on an
invalid value**, naming the variable.

### Core

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `5000` | |
| `NODE_ENV` | `development` | `development` \| `production` \| `test` |
| `DATABASE_URL` | **required** | |
| `BETTER_AUTH_SECRET` | **required** | Min 16 characters |
| `BETTER_AUTH_URL` | `http://localhost:3000` | |
| `FRONTEND_URL` | `http://localhost:3000` | The CORS origin |
| `PUBLIC_BASE_URL` | `http://localhost:5000` | Builds `remoteUri` in the screenshot response. The agent only logs it, so it need not be publicly resolvable - just stable |

### Secrets

| Variable | Default | Notes |
|---|---|---|
| `DEVICE_TOKEN_PEPPER` | dev-only value | **The server refuses to start in production if this is still the default.** Changing it invalidates **every** issued device API key |

### <a id="trust_proxy"></a>Deployment topology

| Variable | Default | Notes |
|---|---|---|
| `TRUST_PROXY` | `false` | Proxy count, or a value Express understands (`loopback`, a CIDR, `true`/`false`) |

**This must match reality.**

| Deployment | Value |
|---|---|
| Exposed directly | `false` |
| Behind one reverse proxy | `1` |
| Behind a CDN in front of a proxy | `2` |

Too low behind a proxy: every request appears to come from the proxy, so the per-IP backstop
collapses onto one bucket and the whole office is limited together. Too high, or `true` with no
proxy: clients can forge `x-forwarded-for` and dodge limits entirely.

### Rate limits (per minute)

| Variable | Default | Keyed by |
|---|---|---|
| `RATE_LIMIT_ENROLL_PER_MIN` | `10` | MachineGuid from the body |
| `RATE_LIMIT_INGEST_PER_MIN` | `200` | Device row id |
| `RATE_LIMIT_SCREENSHOT_PER_MIN` | `60` | Device row id |
| `RATE_LIMIT_UNAUTHENTICATED_PER_MIN` | `3000` | IP, pre-auth backstop |

One agent syncs six channels plus a heartbeat every couple of minutes, so 200/min is orders of
magnitude above normal and exists only to contain an agent stuck in a retry loop.

**Counters are per process.** With N replicas the effective limit is N times these values.

### Ingest

| Variable | Default | Notes |
|---|---|---|
| `JSON_BODY_LIMIT` | `2mb` | The **ceiling**. The agent packs to 900 KB; the headroom absorbs estimate error. Do not equalize them |
| `INGEST_MAX_BATCH_EVENTS` | `500` | Abuse bound. The *operational* size is `syncMaxBatchSize` (100). Deliberately several times higher so an agent that has not picked up a lowered policy is not rejected |
| `INGEST_TRANSACTION_TIMEOUT_MS` | `15000` | Stops a wedged transaction holding locks indefinitely |
| `INGEST_BATCH_RETENTION_DAYS` | `7` | Must outlive the agent's retry window; after that the ledger row can never be consulted |
| `DEVICE_LAST_SEEN_MAX_STALENESS_SECONDS` | `60` | Throttles `lastSeen` writes. Lower means write amplification on the hottest table |

### Storage and database

| Variable | Default | Notes |
|---|---|---|
| `SCREENSHOT_STORAGE_DIR` | `./storage/screenshots` | **Local storage is what blocks horizontal scaling** - each replica holds a different subset |
| `DATABASE_POOL_MAX` | `10` | Burst tolerance, not parallelism. Raise if requests queue behind the pool; divide the database's ceiling between replicas |

## Frontend environment

| Variable | Read by | Notes |
|---|---|---|
| `MONITORING_API_URL` | Next.js **server** | May be an internal hostname |
| `NEXT_PUBLIC_MONITORING_API_URL` | **Browser** (socket) | Must be reachable from the user's machine |

Separate on purpose. Setting only the first leaves the socket pointed at `http://localhost:5000`
from the user's browser.

## Agent install-time config

`%ProgramData%\EmployeeMonitor\agent.config.json`, written by `Deploy-Agent.ps1`.

| Field | Notes |
|---|---|
| `serverUrl` | The service refuses to start without a valid one |
| `enrollmentToken` | Org-wide; traded once for a device API key |
| `allowInsecureHttp` | Permits a plain-HTTP `serverUrl`. Test only |

---

## <a id="policy-fields"></a>Policy fields

One row per organization in `policies`. `GET /api/v1/policy` returns the full document.
Editing any field increments `version`, which triggers a policy fetch **and** a fresh consent
prompt on every agent.

Defaults live in three places that must agree: the Prisma column default, the C# record default in
`AgentPolicy.cs` (what the agent runs on before its first fetch), and the pagination fallbacks in
`Backend/src/modules/report/pagination.ts`.

### Feature switches

| Field | Default |
|---|---|
| `attendanceEnabled` | `true` |
| `activityEnabled` | `true` |
| `appSessionEnabled` | `true` |
| `browserMonitorEnabled` | `true` |
| `screenshotEnabled` | `true` |
| `usbEnabled` | `true` |
| `alertEnabled` | `true` |
| `realtimeEnabled` | `true` |

`screenshotEnabled` defaults on **for testing** and is expected to be turned off before publish.

`realtimeEnabled` off falls the fleet back to poll-only behaviour with no redeploy and no data
loss - the HTTP paths are the system of record either way. A safe switch to flip under load.

### Collection

| Field | Default | Notes |
|---|---|---|
| `idleThresholdSeconds` | `300` | 5 minutes |
| `appSessionPollSeconds` | `1` | |
| `browserUiaTimeoutMs` | `500` | UI Automation read timeout |
| `browserMaxRetryAttempts` | `3` | |
| `screenshotIntervalSeconds` | `600` | |
| `screenshotJpegQuality` | `70` | |
| `usbReconciliationIntervalSeconds` | `5` | |
| `usbAlertOnInsertion` | `false` | |

### Alerts

| Field | Default | Notes |
|---|---|---|
| `alertIdleEnabled` | `true` | |
| `alertIdleNormalSeconds` | `1800` | 30 min |
| `alertIdleModerateSeconds` | `2700` | 45 min |
| `alertIdleSevereSeconds` | `3600` | 60 min |
| `alertIdleRenotifySeconds` | `900` | |
| `alertBlacklistEnabled` | `true` | |
| `alertOutsideWorkingHours` | `false` | Desktop notifications are suppressed outside working hours unless this is set |

Escalation reuses one `clientEventId`, so an escalating incident is one row and one counted alert.

### Sync

| Field | Default | Notes |
|---|---|---|
| `syncBatchIntervalSeconds` | `120` | |
| `syncMaxBatchSize` | `100` | **The main lever on peak server cost.** A fleet of 100 draining a backlog together multiplies this. Capped in the DTO at `INGEST_MAX_BATCH_EVENTS` so an admin cannot configure batches the server would reject |
| `syncMinRetryBackoffSeconds` | `5` | |
| `syncMaxRetryBackoffSeconds` | `120` | |

### Presence

| Field | Default | Notes |
|---|---|---|
| `presenceHeartbeatSeconds` | `30` | A device is `live` if heard from within this x **2.5**. The grace means one dropped frame does not flip a healthy machine offline |

### Dashboard read path

| Field | Default | Ceiling |
|---|---|---|
| `logPageSize` | `50` | 500 |
| `screenshotPageSize` | `12` | 60 |

Separate settings on purpose (AD-13): a page of log rows is a few kilobytes of JSON, a page of
screenshots is that many full-size JPEGs the browser downloads and decodes.

### Retention

| Field | Default |
|---|---|
| `retentionDays` | `90` |
| `undeliveredRetentionDays` | `30` |

### Working hours

| Field | Default |
|---|---|
| `workingHoursStartLocal` | `08:00` |
| `workingHoursEndLocal` | `17:00` |
| `workingDays` | Mon-Fri |

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
