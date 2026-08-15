# Backend

Express + Prisma + PostgreSQL. Listens on port 5000. It is the system of record for everything -
telemetry, policy, identity and audit.

Source root: `Backend/src/`.

---

## Module layout

```
Backend/src/
  server.ts                 composition root: middleware order, route mounting, health check
  config/
    env.ts                  Zod-validated environment; every tunable is documented here
    db.ts                   the Prisma client singleton
    auth.ts                 Better Auth configuration
    tenant.ts               resolves the single organization
  middleware/
    deviceAuth.ts           agent credential  -> req.device
    userAuth.ts             dashboard session -> req.user
    rbac.ts                 requireRole(...)
    rateLimiter.ts          fixed-window limiter with a caller-chosen key
    validate.ts             Zod validation for body/params/query
    auditLogger.ts          writes who-viewed-what
    errorHandler.ts         terminal handler; 4xx warn, 5xx with stack
  lib/
    scheduler.ts            maintenance loop; advisory-locked so one replica sweeps
  modules/
    ingest/                 the agent write path        -> ingest.md
    report/                 the dashboard read path     -> reporting.md
    attendance/             closes sessions the workstation never could -> ingest.md section 9
    employee/               employees and device inventory
    organization/           organizations, policy, categories
    auth/                   login, register, /me, realtime ticket
  realtime/                 Socket.IO namespaces        -> realtime.md
  utils/token.ts            enrollment token and device API key hashing
```

Each module is `*.routes.ts` -> `*Controller.ts` -> `*Service.ts`, with `*.dto.ts` holding the
Zod schemas. Controllers are thin: they unwrap the request, call one service method, and shape
the response. Business logic that touches more than one table belongs in the service.

`attendance/` has no routes. It exists because one piece of state can go wrong with nobody left to
fix it: a workstation that loses power never closes its attendance session, and no request will
ever arrive to repair it. The scheduler is what calls it.

## Request lifecycle

Middleware order in `server.ts` is load-bearing, not stylistic:

```
helmet -> cors -> morgan
  -> app.all('/api/auth/{*any}', toNodeHandler(auth))     <-- BEFORE express.json()
  -> express.json({ limit: JSON_BODY_LIMIT })
  -> GET /health
  -> /api/v1          (ingestRoutes)     agents
  -> /v1/dashboard/*  (auth, orgs, employees, reports)   humans
  -> errorHandler
```

**The Better Auth handler must be mounted before `express.json()`.** It reads the raw request
body itself; a parsed body means it sees nothing and every login fails with an opaque error.

`app.set('trust proxy', ...)` runs before everything, because any middleware reading `req.ip`
depends on it. See [../reference/configuration.md](../reference/configuration.md#trust_proxy).

## The two surfaces

| | `/api/v1/*` | `/v1/dashboard/*` |
|---|---|---|
| Caller | Windows agent | Signed-in human |
| Gate | `deviceAuth` | `userAuth` + `requireRole` |
| Body envelope | Endpoint-specific | `{ status, message, data }` |
| Rate limit key | Device row id | IP |
| Audited | No - too high volume | Yes, every read |
| Reference | [../reference/agent-api.md](../reference/agent-api.md) | [../reference/dashboard-api.md](../reference/dashboard-api.md) |

They must never share middleware. See [security.md](security.md).

## Health check

`GET /health` runs `SELECT 1` rather than returning a constant. A process that is listening but
cannot reach Postgres serves 500s on every write, and a health check that answers "ok" for it is
worse than none - it tells the load balancer to keep sending traffic into a hole.

It returns 503 with `reason: "database unreachable"` when the probe fails.

## Where to add code

| Adding... | Goes in | Also update |
|---|---|---|
| A telemetry field | `ingest.dto.ts`, `schema.prisma`, `ingestService.ts` | Agent contracts, `Frontend/src/types/api.ts` - see [../architecture/cross-tier-contracts.md](../architecture/cross-tier-contracts.md) |
| A telemetry channel | `CHANNELS` in `ingest.dto.ts`, a `prepare*` method | Agent `ToWireName`, [../reference/agent-api.md](../reference/agent-api.md) |
| A report | `reportService.ts` + `report.routes.ts` with `requireRole` and `auditLogger` | [../reference/dashboard-api.md](../reference/dashboard-api.md) |
| A policy field | `Policy` in `schema.prisma` | `AgentPolicy.cs`, `PolicyForm.tsx`, [../reference/configuration.md](../reference/configuration.md) |
| A tunable | `config/env.ts` with a comment saying what breaks at the wrong value | `.env.example`, [../reference/configuration.md](../reference/configuration.md) |

## Commands

```bash
cd Backend
npm run dev                 # port 5000
npx prisma migrate dev      # apply and create migrations
npm run seed                # creates the org, prints the enrollment token ONCE
npm test                    # integration smoke against the real database
npm run build && npm start  # production
```

`npm test` is not a unit-test suite - it exercises enrollment, auth boundaries, per-channel
validation, column-level persistence, idempotency and the device kill switch against a real
database. It is the thing that catches a broken wire contract.

`npm run build` writes `dist/package.json` marking CommonJS: the root package is
`"type": "module"` while tsconfig emits CommonJS, so Node refuses to load the output without it.

---

## Related

- [ingest.md](ingest.md) - the write path
- [reporting.md](reporting.md) - the read path
- [realtime.md](realtime.md) - Socket.IO
- [security.md](security.md) - auth, RBAC, rate limiting, audit
- [spec.md](spec.md) - the original governing specification
- [../operations/backend-deployment.md](../operations/backend-deployment.md) - production
- [../reference/data-model.md](../reference/data-model.md) - tables and indexes
