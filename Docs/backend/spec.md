> **STATUS: original governing specification.** Written before the code existed, and parts of it
> have been overtaken by the implementation. It is kept because it states the *intent* behind the
> design and because sections 12.1-12.7 are current and detailed.
>
> **Where the code has moved on:**
>
> | This document says | The code does |
> |---|---|
> | Ingest prefix `/v1/ingest/*` | `/api/v1/*` - see [../reference/agent-api.md](../reference/agent-api.md) |
> | `src/controllers/`, `src/services/`, `src/dtos/` | `src/modules/<domain>/` with routes, controller, service and DTO together |
> | "User JWT (email/password login)" | Better Auth sessions - opaque tokens, not JWTs |
>
> For what the code does **now**, start at [README.md](README.md). This file is the reasoning
> behind it, not a description of it.

---

# AGENTS.md - Monitoring Server (Express + Prisma + Postgres)

Governing spec for `monitoring-server/`. Read before writing code in any folder below.
This repo has two audiences hitting the same API for very different reasons - Windows
agents pushing activity data, and the Next.js dashboard reading reports for humans.
Keeping those two flows structurally separate is the single most important rule in
this document.

---

## 1. The two flows this server serves

|                          | Write path (agents)                                                                         | Read path (dashboard)           |
| ------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------- |
| Caller                   | Windows agent, unattended                                                                   | Manager/HR, logged-in human     |
| Auth                     | Per-device token                                                                            | User JWT (email/password login) |
| Route prefix             | `/v1/ingest/*`                                                                              | `/v1/dashboard/*`               |
| Frequency                | Every 1-5 min, 30-100 devices                                                               | On page load / filter change    |
| Failure mode if confused | A stolen device token could read reports; a stolen dashboard JWT could inject fake activity |                                 |

**Rule**: these two auth mechanisms must never share middleware, and route prefixes
must make it obvious at a glance which flow a route belongs to. If you're adding a
route and unsure which prefix it goes under, ask "does a machine call this, or does a
person call this" - that answer decides it.

```
Backend/
+-- src/
|   +-- modules/
|   |   +-- auth/
|   |   |   +-- auth.routes.ts
|   |   |   +-- auth.controller.ts
|   |   |   +-- auth.service.ts
|   |   |   +-- strategies/
|   |   |       +-- jwt.strategy.ts
|   |   |       +-- device-token.strategy.ts
|   |   +-- devices/
|   |   |   +-- devices.routes.ts
|   |   |   +-- devices.controller.ts
|   |   |   +-- devices.service.ts
|   |   |   +-- devices.dto.ts
|   |   +-- ingestion/
|   |   |   +-- ingestion.routes.ts
|   |   |   +-- ingestion.controller.ts
|   |   |   +-- ingestion.service.ts
|   |   |   +-- activity-batch.dto.ts
|   |   +-- activity/
|   |   |   +-- activity.service.ts
|   |   |   +-- activity.repository.ts
|   |   +-- attendance/
|   |   |   +-- attendance.service.ts
|   |   |   +-- attendance.repository.ts
|   |   +-- categorization/
|   |   |   +-- categorization-engine.ts
|   |   |   +-- strategies/
|   |   |       +-- keyword-rule.strategy.ts
|   |   |       +-- domain-rule.strategy.ts
|   |   +-- screenshots/
|   |   |   +-- screenshots.routes.ts
|   |   |   +-- screenshots.controller.ts
|   |   |   +-- screenshots.service.ts
|   |   +-- reports/
|   |   |   +-- reports.routes.ts
|   |   |   +-- reports.controller.ts
|   |   |   +-- reports.service.ts
|   |   |   +-- exporters/
|   |   |       +-- csv-exporter.ts
|   |   |       +-- pdf-exporter.ts
|   |   +-- audit/
|   |   |   +-- audit.service.ts
|   |   |   +-- audit.middleware.ts          # wraps every route to log access
|   |   +-- retention/
|   |   |   +-- retention.job.ts
|   |   +-- users/
|   |       +-- users.routes.ts
|   |       +-- users.controller.ts
|   |       +-- users.service.ts
|   +-- common/
|   |   +-- interfaces/
|   |   |   +-- activity-repository.interface.ts
|   |   |   +-- attendance-repository.interface.ts
|   |   |   +-- feature-flags.interface.ts
|   |   |   +-- clock.interface.ts
|   |   +-- middlewares/
|   |   |   +-- auth.middleware.ts           # verifies JWT / device token
|   |   |   +-- roles.middleware.ts          # RBAC guard
|   |   |   +-- error-handler.middleware.ts
|   |   |   +-- rate-limit.middleware.ts
|   |   +-- validators/                      # request schemas (zod/joi)
|   +-- infrastructure/
|   |   +-- postgres/
|   |   |   +-- db.ts                        # pool/client init
|   |   |   +-- models/
|   |   |   |   +-- employee.model.ts
|   |   |   |   +-- device.model.ts
|   |   |   |   +-- activity-log.model.ts
|   |   |   |   +-- attendance.model.ts
|   |   |   |   +-- screenshot.model.ts
|   |   |   |   +-- category.model.ts
|   |   |   |   +-- user.model.ts
|   |   |   |   +-- audit-log.model.ts
|   |   |   +-- migrations/
|   |   +-- storage/local-disk-storage.adapter.ts
|   |   +-- mailer/smtp-mailer.adapter.ts
|   +-- container.ts                         # composition root - manual/awilix DI wiring
|   +-- routes/index.ts                      # mounts all module routers
|   +-- app.ts                                # Express app: middleware + route mounting
|   +-- server.ts                             # entrypoint - http.listen
+-- test/
    +-- unit/
    +-- integration/
    +-- contract/activity-batch.contract.spec.ts
```

---

## 2. Directory structure

```
monitoring-server/
+-- prisma/                  # Database schema
|   +-- schema.prisma
+-- src/
|   +-- config/              # env, db, auth (Better Auth instance)
|   +-- controllers/         # Request handlers
|   +-- routes/              # Express routes
|   +-- services/            # Business logic
|   +-- middleware/          # Auth, validation, error
|   +-- utils/               # Helpers
|   +-- dtos/                # Data Transfer Objects
|   +-- server.ts
+-- .env
+-- tsconfig.json
+-- package.json
+-- nodemon.json
```

Every section below maps onto this tree - section 3 covers `prisma/schema.prisma`, section 4
covers `src/config/`, section 5 covers `src/middleware/`, section 6 covers `src/services/`, section 7
covers `src/controllers/` + `src/routes/`, section 8 covers `src/dtos/`.

---

## 3. prisma/schema.prisma - data model

Mirrors the parent spec's data model (section 7) directly - do not rename fields without
updating `API-CONTRACT.md` in lockstep, since the agent's DTOs serialize to these
exact names.

```prisma
model Employee {
  id         String   @id @default(uuid())
  name       String
  email      String   @unique
  department String?
  status     String   @default("active")
  createdAt  DateTime @default(now())
  devices    Device[]
}

model Device {
  id          String   @id @default(uuid())
  employeeId  String
  employee    Employee @relation(fields: [employeeId], references: [id])
  hostname    String
  os          String
  agentVersion String
  tokenHash   String   // device token, hashed - never store raw
  lastSeen    DateTime?
  activityLogs ActivityLog[]
}

model ActivityLog {
  id           String   @id @default(uuid())
  deviceId     String
  device       Device   @relation(fields: [deviceId], references: [id])
  appName      String?
  windowTitle  String?
  domain       String?  // Phase 2, nullable until browser tracker ships
  isIdle       Boolean
  capturedAt   DateTime
  createdAt    DateTime @default(now())

  @@index([deviceId, capturedAt])
}

model Attendance {
  id                 String   @id @default(uuid())
  employeeId         String
  date               DateTime @db.Date
  firstLogin         DateTime
  lastLogout         DateTime?
  totalActiveSeconds Int      @default(0)

  @@unique([employeeId, date])
}

model Category {
  id       String @id @default(uuid())
  pattern  String // app name or domain
  category String // productive | neutral | unproductive
}

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  role         String   // super_admin | manager | auditor
  isActive     Boolean  @default(true)
}

model AuditLog {
  id        String   @id @default(uuid())
  userId    String
  action    String
  target    String
  timestamp DateTime @default(now())
  ipAddress String
}

model IngestBatch {
  // idempotency ledger - see section 5
  idempotencyKey String   @id
  deviceId       String
  processedAt    DateTime @default(now())
}
```

**Index note**: `@@index([deviceId, capturedAt])` on `ActivityLog` is not optional -
every dashboard timeline query filters by device and date range, and without this
index that query degrades badly once you're past a few weeks of data across 30+
devices.

---

## 4. src/config/ - env, db, auth

- `env.ts`: validate all required env vars at boot (`DATABASE_URL`, `JWT_SECRET`,
  `DEVICE_TOKEN_PEPPER`) using `zod` - fail fast on startup, not on first request.
- `db.ts`: single shared Prisma client instance, exported once - never instantiate
  `PrismaClient` per-request.
- `jwt.ts`: signing/verification for **user JWTs only**. Device token verification is
  a separate, simpler mechanism (hash comparison, not JWT) - see section 5. Don't reuse this
  module for device auth; conflating the two is exactly the mistake section 1 warns against.

---

## 5. src/middleware/ - the enforcement layer

| Middleware        | Applies to                     | Responsibility                                                                                                                                                                                                       |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceAuth.ts`   | `/v1/ingest/*` only            | Look up `tokenHash` for the claimed device, reject if missing/revoked. Updates `Device.lastSeen`.                                                                                                                    |
| `userAuth.ts`     | `/v1/dashboard/*` only         | Verify JWT, attach `req.user` (id, role)                                                                                                                                                                             |
| `rbac.ts`         | `/v1/dashboard/*` routes       | Given `req.user.role`, check against a route's required role(s). Reject with 403 before the controller runs.                                                                                                         |
| `validate.ts`     | All routes                     | Wraps a `zod` schema per route; agents and dashboard clients both send untrusted input - never trust either.                                                                                                         |
| `auditLogger.ts`  | `/v1/dashboard/*` reads        | Writes an `AuditLog` row on every report/employee-detail view - required by parent spec section 3.1 ("every access is logged"). This runs _after_ RBAC passes - don't log denied attempts as if they were legitimate views. |
| `errorHandler.ts` | Global, last in chain          | Normalize errors to a consistent JSON shape; never leak stack traces in production responses.                                                                                                                        |
| `rateLimiter.ts`  | `/v1/ingest/*` and auth routes | Protects against a malfunctioning agent retry-looping, and against login brute-forcing                                                                                                                               |

RBAC role table (mirrors parent spec section 6):

| Role          | Permissions                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `super_admin` | Everything: settings, retention config, user management, all reports             |
| `manager`     | Reports + employee detail for assigned team only - no config, no user management |
| `auditor`     | Read-only audit log + aggregate reports - cannot view individual screenshots     |

---

## 6. src/services/ - business logic

### `ingestService.ts`

Handles the write path. Two responsibilities that must both be present:

1. **Idempotency check**: before inserting, check `IngestBatch` for the incoming
   `Idempotency-Key` header. If found, return the previous success response without
   re-inserting - this is what makes agent retries safe (see the agent-side
   `Agent.md` section 6.2). If not found, insert the batch's `ActivityLog` rows and the
   `IngestBatch` ledger row in **one transaction** - partial success must not happen.
2. **Device token validation** happens in middleware (section 5), not here - this service
   assumes the caller is already an authenticated device.

```typescript
export async function ingestBatch(deviceId: string, idempotencyKey: string, samples: RawSample[]) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ingestBatch.findUnique({ where: { idempotencyKey } });
    if (existing) return { alreadyProcessed: true };

    await tx.activityLog.createMany({ data: samples.map((s) => ({ ...s, deviceId })) });
    await tx.ingestBatch.create({ data: { idempotencyKey, deviceId } });
    await tx.device.update({ where: { id: deviceId }, data: { lastSeen: new Date() } });

    return { alreadyProcessed: false, inserted: samples.length };
  });
}
```

### `reportService.ts`

Handles the read path - aggregation queries (active/idle time per employee/day,
team summaries). Keep these as focused, named functions
(`getTeamSummary(dateRange)`, `getEmployeeTimeline(employeeId, date)`) rather than
one generic "query builder" - the dashboard's fixed set of report views doesn't need
that flexibility, and named functions are far easier for a junior dev (or an AI
assistant) to locate and modify safely.

### Authentication: Better Auth, not hand-rolled JWT
**Superseded from the original plan.** Dashboard user auth (login, session,
password hashing) is handled by **Better Auth** (`config/auth.ts`), not a
custom `authService.ts` with manual bcrypt/JWT logic. Better Auth owns the
`user`, `session`, `account`, and `verification` tables (extended with a
`role` field via `additionalFields`) and issues an httpOnly session cookie -
see the dashboard's `AGENTS.md` section 3, which already assumed this shape.

Key decisions baked into `config/auth.ts`:
- **No public self-registration.** A `databaseHooks.user.create.before` hook
  blocks the `/sign-up/email` route specifically. Every account is created
  through `services/accountService.ts`, which wraps the **admin plugin's**
  `auth.api.createUser` - the only sanctioned path, restricted to
  `super_admin` via `requireRole` on `routes/users.routes.ts`.
- **`trustedOrigins`** must list every deployed dashboard URL plus local dev.
  Missing an entry here reproduces the `INVALID_ORIGIN` failure mode already
  seen on a past project - check this first if login mysteriously fails in
  one environment but not another.
- **Mount order in `server.ts` is load-bearing**: Better Auth's catch-all
  route (`app.all('/api/auth/*', toNodeHandler(auth))`) must be registered
  *before* `express.json()`. Better Auth reads the raw body itself; reversing
  this order causes the client to hang on "pending" with no clear error.
- Device-token auth (`deviceAuth.ts`) is completely separate from Better
  Auth and always will be - machines aren't users, and routing agent auth
  through Better Auth "for consistency" reopens the exact write-path/
  read-path confusion section 1 exists to prevent.

### `categoryService.ts`

Applies productive/neutral/unproductive tagging based on the `Category` table -
called by `reportService` when building summaries, not stored redundantly on each
`ActivityLog` row (categorization rules can change retroactively; recomputing at
report time keeps historical data reinterpretable under new rules).

---

## 7. src/controllers/ + src/routes/ - thin by design

Controllers only: parse `req`, call one service method, shape the response. No
business logic, no Prisma calls directly in a controller - that always belongs in
`services/`. This split is what keeps the ingest and dashboard flows testable in
isolation (mock the service, not the whole HTTP stack).

Route files mirror section 1's prefix split explicitly:

```
routes/
  ingest.routes.ts     # POST /v1/ingest/activity   (deviceAuth only)
  auth.routes.ts       # POST /v1/dashboard/auth/login
  employees.routes.ts  # GET  /v1/dashboard/employees  (userAuth + rbac)
  reports.routes.ts    # GET  /v1/dashboard/reports/*  (userAuth + rbac + auditLogger)
```

---

## 8. src/dtos/ - the contract boundary

DTOs here must match the agent's `Core/Models` field-for-field (see `Agent.md` section 4.2).
Validate every incoming payload against a `zod` schema derived from the DTO shape
before it reaches a service - this is the server's half of the "never trust client
input" rule; the agent validates on its side too, but the server cannot assume that
held.

---

## 9. Security requirements (binding, from parent spec section 9)

- HTTPS/TLS only - reject plain HTTP at the reverse proxy level, not just in Express.
- Device tokens stored as **hashes** (`tokenHash`), never raw - same principle as
  password storage, since a leaked database shouldn't hand out working credentials.
- Passwords: bcrypt or argon2, never anything reversible.
- RBAC enforced on **every** dashboard route - no route reachable by guessing a URL
  without a role check.
- Rate limiting + input validation on all endpoints, ingest included.
- Audit log is append-only from the application's perspective - no update/delete
  route should ever target `AuditLog`.

---

## 10. Phase mapping (month-1 MVP)

| Component                                                                 | Priority                                                                                       | Month-1?                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Prisma schema (Employee, Device, ActivityLog, Attendance, User, AuditLog) | M                                                                                              | **Yes**                                                                       |
| `deviceAuth`, `userAuth`, `rbac` middleware                               | M                                                                                              | **Yes**                                                                       |
| `ingestService` with idempotency                                          | M                                                                                              | **Yes** - this is what makes the agent's retry logic safe; cannot be deferred |
| `reportService` basic team/employee views                                 | M                                                                                              | **Yes**                                                                       |
| CSV/PDF export                                                            | S                                                                                              | Defer                                                                         |
| `Category` table + productivity tagging                                   | M (per original spec) but can ship with a manually-seeded default list rather than an admin UI | Partial - seed data yes, admin UI defer                                       |
| Screenshots table + storage                                               | S                                                                                              | Defer                                                                         |
| Auditor role, full audit-log UI                                           | S/M split                                                                                      | Backend model yes; dedicated UI can defer                                     |

---

## 11. Definition of done (month-1 MVP)

- An agent with a valid device token can POST a batch and have it land in
  `ActivityLog` exactly once, even when the same batch is sent twice.
- A manager can log in, see only their team's data, and every view they make is
  recorded in `AuditLog`.
- No dashboard route is reachable without a valid JWT + correct role.
- No device token can reach any `/v1/dashboard/*` route, and no user JWT can reach
  `/v1/ingest/*`.

---

## 12. Realtime signalling, ingest idempotency, and the daily rollup

Three changes that belong together: they are what takes this server from "works at 30 devices"
to "works at 100+".

### 12.1 Socket.IO is signalling - never data, never availability

`src/realtime/` mounts two authenticated namespaces on the same port as the REST API:

| Namespace | Who | Credential |
|---|---|---|
| `/agents` | Windows agents | device API key in the handshake `auth.apiKey` |
| `/dashboard` | Browsers | short-lived ticket in `auth.ticket` (see below) |

It carries **"something changed, come and get it"** and nothing that matters if it is lost:
`policy:updated`, `sync:force`, `device:deactivated` to agents; `telemetry:ingested`,
`device:presence`, `policy:updated` to dashboards.

Telemetry keeps travelling over HTTP. That path is acknowledged, retried and idempotent; a socket
that silently half-dies would lose data with no way to detect it.

**An open socket is not proof the server is available.** This is a rule, not a preference. A
connection survives a database outage, a deploy, and a half-open TCP path that will not surface
for minutes - so treating "connected" as "available" has agents confidently pushing telemetry at a
server that is dropping it. Therefore:

- the **agent** gates syncing on `GET /api/v1/heartbeat`, which proves the credential is accepted
  *and* that the server reached Postgres to answer;
- `GET /health` runs a real `SELECT 1` and answers **503** when the database is unreachable;
- the **dashboard** shows a device as online from `devices.lastSeen`, which only an authenticated
  HTTP request writes. Socket presence is exposed separately and answers a narrower question:
  would a force-sync sent right now be delivered immediately?

**Dashboard tickets.** The dashboard's session lives in an httpOnly cookie so page scripts cannot
read it. Handing that token to the browser for a handshake would undo the only protection the
cookie provides. Instead `POST /v1/dashboard/auth/realtime-ticket` exchanges the session for a
signed, ~60-second credential that opens a socket and can do nothing else - the REST API does not
accept it. See `src/realtime/ticket.ts`.

Single-process by design: at this fleet size one Node process holds every connection, so there is
no Redis adapter. Running more than one instance would need one.

### 12.2 Two layers of ingest idempotency

The agent's queue is at-least-once, so a batch that was committed but whose HTTP response was lost
is resent verbatim.

1. **Per batch** - `ingest_batches`, unique on `(deviceId, batchId)`. The agent derives `batchId`
  deterministically from a SHA-256 of its sorted event ids, so a resend of the same events
  produces the same id. The backend compares the batch with a SHA-256 of the sorted canonical
  full event contents before treating it as a replay. A known, unchanged batch is answered from
  the ledger without touching the telemetry tables. This is the layer that matters when a fleet
  reconnects after an outage and replays at once. A content mismatch falls back to layer 2 rather
  than discarding real telemetry. This is required for attendance, where successive revisions
  reuse `clientEventId` while changing fields such as `logoutTime`.
2. **Per event** - the unique `clientEventId` on every channel. Still the backstop for an older
   agent, or a retry that repacked its queue into a different batch.

The ledger row is written **inside the same transaction as the events**, so it can never claim a
batch that did not land. It is pruned after `INGEST_BATCH_RETENTION_DAYS` (default 7) - it only has
to outlive the agent's retry window.

### 12.3 The daily rollup

`daily_activity_rollups` holds one row per `(workDate, deviceId, employeeId)`, maintained as data
arrives. Reports read it; they never scan the log tables to aggregate.

This is the query that does not survive the jump to 100+ devices. Summing `activity_sessions` over
a date range means millions of ten-second app switches re-scanned by every manager who opens the
overview - and it degrades with *history*, not headcount, so it gets worse forever. A month for
100 employees is ~3,000 rollup rows, and that ceiling does not move.

Keyed on employee as well as device so a workstation reassigned mid-day produces two rows rather
than one row silently changing owner - yesterday's report does not move when today's assignment
changes.

**Counters are incremented, never recomputed**, so counting one event twice corrupts a day
permanently and silently. Exactly-once is guaranteed by the batch ledger plus a pre-filter: each
channel counts only the events it genuinely inserted. Browser time is deliberately *not* added to
`activeSeconds` - the browser was already the foreground app for that interval and its
`ActivitySession` counted it.

Work dates come from the agent's own calendar date via the attendance session, falling back to the
UTC date of the event's timestamp. A fleet spanning timezones would otherwise have days starting
at the server's midnight.

### 12.4 Log feeds are keyset-paginated

No log endpoint returns "everything in the range". Each serves one page, newest first, through an
opaque cursor (`src/modules/report/pagination.ts`).

`OFFSET` is deliberately not used: `OFFSET 5000` makes Postgres walk and discard 5,000 rows to
return 50, so a page costs more the further an operator scrolls - backwards for a log whose
interesting rows are at the end. It is also unstable under a live feed, repeating or skipping rows
as data arrives. A keyset cursor carries `(timestamp, id)` of the last row; every page is the same
indexed seek. The id is part of the key because timestamps collide - an agent can close several
app sessions in the same millisecond.

Pages are over-fetched by one row to answer "is there more?" without a second `COUNT` over the same
predicate.

Page size comes from `Policy.logPageSize` (default 50), so an admin changes it from the settings
screen. A caller may request fewer, never more.

The screenshot index (`GET /v1/dashboard/reports/employees/:employeeId/screenshots`) is one of
these feeds and returns `{ rows, nextCursor, hasMore, period }`. It previously returned a flat
`{ screenshots }` array capped at `take: 500` - an arbitrary ceiling that silently hid older
captures while still being far more than the gallery shows before the operator scrolls. Screenshots
accumulate faster than any other record here (one every few minutes, per device, per employee), so
the same cursor discipline applies. Rows carry `deviceName` joined from the employee's devices, not
per row, so a two-machine employee's interleaved captures can be told apart.

Its page size is `Policy.screenshotPageSize` (default **12**), **not** `logPageSize` (default 50),
and the two must not be merged. A page of log rows is a few kilobytes of JSON; a page of
screenshots is that many full-size JPEGs the browser actually downloads and decodes. At roughly
half a megabyte a capture, a 50-item page is ~25 MB of image traffic for one flick of the scroll
wheel, on a grid that shows six at a time. The hard ceiling is correspondingly lower - 60 rather
than 500 - because the cost being bounded is bytes in flight, not rows returned.

The image bytes are **not** in the index. `GET /v1/dashboard/reports/screenshots/:deviceId/:file`
serves one capture per request, which is what makes every view a separate `VIEW_SCREENSHOT` audit
entry (spec section 3). Both routes exclude the Auditor role (spec section 6); the service also verifies the
capture belongs to the device in the path, so guessing a `clientEventId` against another device's
id returns 404.

### 12.5 Admin-configurable limits

| Setting | Default | What it controls |
|---|---|---|
| `Policy.syncMaxBatchSize` | 100 | Events per agent push. The main lever on peak server cost. |
| `Policy.syncBatchIntervalSeconds` | 120 | How often an agent drains its queue. |
| `Policy.logPageSize` | 50 | Rows per dashboard log page. |
| `Policy.screenshotPageSize` | 12 | Captures per gallery page. Separate from `logPageSize` because the cost is image bytes, not rows - see section 12.4. Ceiling 60. |
| `Policy.screenshotJpegQuality` | 70 | Capture quality. Trades storage and bandwidth against legibility; editable from the settings screen. |
| `Policy.realtimeEnabled` | true | Whether agents and dashboards hold a socket at all. |
| `INGEST_MAX_BATCH_EVENTS` (env) | 500 | Server-side abuse bound. The policy value is capped to it, so an admin cannot configure batches the server would reject. |

Turning `realtimeEnabled` off falls the fleet back to poll-only without a redeploy. The HTTP paths
are the system of record either way, so it is a safe switch to flip under load.

### 12.6 Live presence - how "Active now" is decided

The dashboard's activeness indicator is driven by a heartbeat, not by connection state.

A connected agent emits `agent:heartbeat` every `Policy.presenceHeartbeatSeconds` (default 30).
The server records it, writes `devices.lastSeen` through the shared throttle
(`modules/ingest/deviceLiveness.ts` - the one place that column is written, so the HTTP and socket
paths cannot disagree about what "recently seen" means), and fans a `device:presence` event out to
the organization's dashboards.

**Why a heartbeat rather than the socket itself.** A half-open TCP connection outlives an
unplugged cable, a suspended laptop or a dropped VPN by minutes - nothing needs to be sent for the
OS to keep believing in it. A dashboard that showed "online" because a socket object existed would
be confidently wrong for exactly as long as that takes. A heartbeat that *arrives* is positive
evidence at a known instant. So `devicePresence.isLive()` is a function of `lastHeartbeatAt`, and a
device holding a socket it has gone silent on reads as **not** live - precisely the half-open case.

A device is live while its last heartbeat is within `presenceHeartbeatSeconds x 2.5`. The grace
multiplier means one dropped or delayed frame - a GC pause, a busy uplink - does not flip a healthy
workstation to offline and back.

Note this does **not** contradict section 12.1. Those are two different questions:

| Question | Answered by | Why |
|---|---|---|
| Is the *backend* available? (agent's decision to sync) | `GET /api/v1/heartbeat` | Must prove the server can reach its database, which no socket state implies. |
| Is this *device* active? (dashboard's display) | agent heartbeat over the socket | Positive, timestamped evidence from the machine itself, seconds old rather than minutes. |

**Scoping.** `devicePresence.snapshot()` requires an organization id and has no unscoped variant -
a caller that forgets it fails to compile rather than quietly returning every connected device to
one tenant's dashboard. Presence entries carry their owning organization for this reason.

**Snapshot on connect.** A dashboard receives `device:presence-snapshot` immediately, carrying the
current table and the silence window. Without it, devices that connected before the browser did
would show as offline until each happened to heartbeat - up to a full interval of wrong information
on the first screen an operator looks at. The window is sent rather than hardcoded in the client so
changing the interval in admin config does not need a frontend release.

**Known limitation.** The dashboard namespace resolves its organization with
`currentOrganizationId()`, which returns the oldest organization row, because dashboard users have
no organization column. Correct for this single-tenant deployment; it is the first thing that must
change if a second organization is ever provisioned. The smoke test works around it explicitly.

### 12.7 The ingest event carries the aggregate, not a hint

`telemetry:ingested` ships the totals the batch contributed, taken straight from the accumulator
that just wrote the rollup. The dashboard adds them to what it is showing and its figures move -
no request, no refetch, no recomputation per viewer. The aggregation happened once, at ingest;
this reuses it.

**Deltas, never absolutes.** A dashboard is showing some range across some set of employees, and
it has no way to fold one `(day, device, employee)` row's absolute total into that without knowing
what that key already contributed. Adding what just arrived is something it can always do
correctly, whatever it happens to be displaying.

**Aggregates, never rows.** This is the line that has not moved. A delta is safe to push because
applying it is unconditional arithmetic. Rows are not: a client would have to decide whether each
belongs in its current view, deduplicate it against what it holds, and reconcile after every
missed event - which is how a socket-fed cache drifts from the database with nothing to detect it.
Log tables therefore still page from the API (section 12.4).

**Replays contribute nothing.** A batch recognized by the ledger returns before the broadcast, and
`eventCount` is the number genuinely stored, so a resend cannot move anyone's numbers.

The client clears its accumulated deltas whenever it refetches, because at that moment the
server-rendered baseline already includes them. That reset is what keeps the two from
double-counting, and it is also the correction path for a client that missed events while
disconnected.

> **Fragility noticed while testing this, not fixed here.** `activity_sessions.sessionId` is a
> *required* FK onto `attendance_sessions`. An activity batch arriving before its attendance row
> fails the whole request with a 500, which the agent treats as transient and retries forever.
> In practice `SyncWorker.SyncOnceAsync` always pushes attendance first, which is why this has
> never been hit - but unlike the browser and USB channels, which null unknown parents rather than
> reject, this one has no tolerance for arriving out of order.
