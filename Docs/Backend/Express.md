# AGENTS.md — Monitoring Server (Express + Prisma + Postgres)

Governing spec for `monitoring-server/`. Read before writing code in any folder below.
This repo has two audiences hitting the same API for very different reasons — Windows
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
person call this" — that answer decides it.

```
Backend/
├── src/
│ ├── modules/
│ │ ├── auth/
│ │ │ ├── auth.routes.ts
│ │ │ ├── auth.controller.ts
│ │ │ ├── auth.service.ts
│ │ │ └── strategies/
│ │ │ ├── jwt.strategy.ts
│ │ │ └── device-token.strategy.ts
│ │ ├── devices/
│ │ │ ├── devices.routes.ts
│ │ │ ├── devices.controller.ts
│ │ │ ├── devices.service.ts
│ │ │ └── devices.dto.ts
│ │ ├── ingestion/
│ │ │ ├── ingestion.routes.ts
│ │ │ ├── ingestion.controller.ts
│ │ │ ├── ingestion.service.ts
│ │ │ └── activity-batch.dto.ts
│ │ ├── activity/
│ │ │ ├── activity.service.ts
│ │ │ └── activity.repository.ts
│ │ ├── attendance/
│ │ │ ├── attendance.service.ts
│ │ │ └── attendance.repository.ts
│ │ ├── categorization/
│ │ │ ├── categorization-engine.ts
│ │ │ └── strategies/
│ │ │ ├── keyword-rule.strategy.ts
│ │ │ └── domain-rule.strategy.ts
│ │ ├── screenshots/
│ │ │ ├── screenshots.routes.ts
│ │ │ ├── screenshots.controller.ts
│ │ │ └── screenshots.service.ts
│ │ ├── reports/
│ │ │ ├── reports.routes.ts
│ │ │ ├── reports.controller.ts
│ │ │ ├── reports.service.ts
│ │ │ └── exporters/
│ │ │ ├── csv-exporter.ts
│ │ │ └── pdf-exporter.ts
│ │ ├── audit/
│ │ │ ├── audit.service.ts
│ │ │ └── audit.middleware.ts # wraps every route to log access
│ │ ├── retention/
│ │ │ └── retention.job.ts
│ │ └── users/
│ │ ├── users.routes.ts
│ │ ├── users.controller.ts
│ │ └── users.service.ts
│ ├── common/
│ │ ├── interfaces/
│ │ │ ├── activity-repository.interface.ts
│ │ │ ├── attendance-repository.interface.ts
│ │ │ ├── feature-flags.interface.ts
│ │ │ └── clock.interface.ts
│ │ ├── middlewares/
│ │ │ ├── auth.middleware.ts # verifies JWT / device token
│ │ │ ├── roles.middleware.ts # RBAC guard
│ │ │ ├── error-handler.middleware.ts
│ │ │ └── rate-limit.middleware.ts
│ │ └── validators/ # request schemas (zod/joi)
│ ├── infrastructure/
│ │ ├── postgres/
│ │ │ ├── db.ts # pool/client init
│ │ │ ├── models/
│ │ │ │ ├── employee.model.ts
│ │ │ │ ├── device.model.ts
│ │ │ │ ├── activity-log.model.ts
│ │ │ │ ├── attendance.model.ts
│ │ │ │ ├── screenshot.model.ts
│ │ │ │ ├── category.model.ts
│ │ │ │ ├── user.model.ts
│ │ │ │ └── audit-log.model.ts
│ │ │ └── migrations/
│ │ ├── storage/local-disk-storage.adapter.ts
│ │ └── mailer/smtp-mailer.adapter.ts
│ ├── container.ts # composition root — manual/awilix DI wiring
│ ├── routes/index.ts # mounts all module routers
│ ├── app.ts # Express app: middleware + route mounting
│ └── server.ts # entrypoint — http.listen
└── test/
├── unit/
├── integration/
└── contract/activity-batch.contract.spec.ts
```

---

## 2. prisma/schema.prisma — data model

Mirrors the parent spec's data model (§7) directly — do not rename fields without
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
  tokenHash   String   // device token, hashed — never store raw
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
  // idempotency ledger — see §5
  idempotencyKey String   @id
  deviceId       String
  processedAt    DateTime @default(now())
}
```

**Index note**: `@@index([deviceId, capturedAt])` on `ActivityLog` is not optional —
every dashboard timeline query filters by device and date range, and without this
index that query degrades badly once you're past a few weeks of data across 30+
devices.

---

## 3. src/config/ — env, db, jwt

- `env.ts`: validate all required env vars at boot (`DATABASE_URL`, `JWT_SECRET`,
  `DEVICE_TOKEN_PEPPER`) using `zod` — fail fast on startup, not on first request.
- `db.ts`: single shared Prisma client instance, exported once — never instantiate
  `PrismaClient` per-request.
- `jwt.ts`: signing/verification for **user JWTs only**. Device token verification is
  a separate, simpler mechanism (hash comparison, not JWT) — see §5. Don't reuse this
  module for device auth; conflating the two is exactly the mistake §1 warns against.

---

## 4. src/middleware/ — the enforcement layer

| Middleware        | Applies to                     | Responsibility                                                                                                                                                                                                       |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceAuth.ts`   | `/v1/ingest/*` only            | Look up `tokenHash` for the claimed device, reject if missing/revoked. Updates `Device.lastSeen`.                                                                                                                    |
| `userAuth.ts`     | `/v1/dashboard/*` only         | Verify JWT, attach `req.user` (id, role)                                                                                                                                                                             |
| `rbac.ts`         | `/v1/dashboard/*` routes       | Given `req.user.role`, check against a route's required role(s). Reject with 403 before the controller runs.                                                                                                         |
| `validate.ts`     | All routes                     | Wraps a `zod` schema per route; agents and dashboard clients both send untrusted input — never trust either.                                                                                                         |
| `auditLogger.ts`  | `/v1/dashboard/*` reads        | Writes an `AuditLog` row on every report/employee-detail view — required by parent spec §3.1 ("every access is logged"). This runs _after_ RBAC passes — don't log denied attempts as if they were legitimate views. |
| `errorHandler.ts` | Global, last in chain          | Normalize errors to a consistent JSON shape; never leak stack traces in production responses.                                                                                                                        |
| `rateLimiter.ts`  | `/v1/ingest/*` and auth routes | Protects against a malfunctioning agent retry-looping, and against login brute-forcing                                                                                                                               |

RBAC role table (mirrors parent spec §6):

| Role          | Permissions                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `super_admin` | Everything: settings, retention config, user management, all reports             |
| `manager`     | Reports + employee detail for assigned team only — no config, no user management |
| `auditor`     | Read-only audit log + aggregate reports — cannot view individual screenshots     |

---

## 5. src/services/ — business logic

### `ingestService.ts`

Handles the write path. Two responsibilities that must both be present:

1. **Idempotency check**: before inserting, check `IngestBatch` for the incoming
   `Idempotency-Key` header. If found, return the previous success response without
   re-inserting — this is what makes agent retries safe (see the agent-side
   `Agent.md` §5.2). If not found, insert the batch's `ActivityLog` rows and the
   `IngestBatch` ledger row in **one transaction** — partial success must not happen.
2. **Device token validation** happens in middleware (§4), not here — this service
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

Handles the read path — aggregation queries (active/idle time per employee/day,
team summaries). Keep these as focused, named functions
(`getTeamSummary(dateRange)`, `getEmployeeTimeline(employeeId, date)`) rather than
one generic "query builder" — the dashboard's fixed set of report views doesn't need
that flexibility, and named functions are far easier for a junior dev (or an AI
assistant) to locate and modify safely.

### `authService.ts`

Login (bcrypt/argon2 compare → JWT issue), never touched by the ingest flow.

### `categoryService.ts`

Applies productive/neutral/unproductive tagging based on the `Category` table —
called by `reportService` when building summaries, not stored redundantly on each
`ActivityLog` row (categorization rules can change retroactively; recomputing at
report time keeps historical data reinterpretable under new rules).

---

## 6. src/controllers/ + src/routes/ — thin by design

Controllers only: parse `req`, call one service method, shape the response. No
business logic, no Prisma calls directly in a controller — that always belongs in
`services/`. This split is what keeps the ingest and dashboard flows testable in
isolation (mock the service, not the whole HTTP stack).

Route files mirror §1's prefix split explicitly:

```
routes/
  ingest.routes.ts     # POST /v1/ingest/activity   (deviceAuth only)
  auth.routes.ts       # POST /v1/dashboard/auth/login
  employees.routes.ts  # GET  /v1/dashboard/employees  (userAuth + rbac)
  reports.routes.ts    # GET  /v1/dashboard/reports/*  (userAuth + rbac + auditLogger)
```

---

## 7. src/dtos/ — the contract boundary

DTOs here must match the agent's `Core/Models` field-for-field (see `Agent.md` §3.2).
Validate every incoming payload against a `zod` schema derived from the DTO shape
before it reaches a service — this is the server's half of the "never trust client
input" rule; the agent validates on its side too, but the server cannot assume that
held.

---

## 8. Security requirements (binding, from parent spec §9)

- HTTPS/TLS only — reject plain HTTP at the reverse proxy level, not just in Express.
- Device tokens stored as **hashes** (`tokenHash`), never raw — same principle as
  password storage, since a leaked database shouldn't hand out working credentials.
- Passwords: bcrypt or argon2, never anything reversible.
- RBAC enforced on **every** dashboard route — no route reachable by guessing a URL
  without a role check.
- Rate limiting + input validation on all endpoints, ingest included.
- Audit log is append-only from the application's perspective — no update/delete
  route should ever target `AuditLog`.

---

## 9. Phase mapping (month-1 MVP)

| Component                                                                 | Priority                                                                                       | Month-1?                                                                      |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Prisma schema (Employee, Device, ActivityLog, Attendance, User, AuditLog) | M                                                                                              | **Yes**                                                                       |
| `deviceAuth`, `userAuth`, `rbac` middleware                               | M                                                                                              | **Yes**                                                                       |
| `ingestService` with idempotency                                          | M                                                                                              | **Yes** — this is what makes the agent's retry logic safe; cannot be deferred |
| `reportService` basic team/employee views                                 | M                                                                                              | **Yes**                                                                       |
| CSV/PDF export                                                            | S                                                                                              | Defer                                                                         |
| `Category` table + productivity tagging                                   | M (per original spec) but can ship with a manually-seeded default list rather than an admin UI | Partial — seed data yes, admin UI defer                                       |
| Screenshots table + storage                                               | S                                                                                              | Defer                                                                         |
| Auditor role, full audit-log UI                                           | S/M split                                                                                      | Backend model yes; dedicated UI can defer                                     |

---

## 10. Definition of done (month-1 MVP)

- An agent with a valid device token can POST a batch and have it land in
  `ActivityLog` exactly once, even when the same batch is sent twice.
- A manager can log in, see only their team's data, and every view they make is
  recorded in `AuditLog`.
- No dashboard route is reachable without a valid JWT + correct role.
- No device token can reach any `/v1/dashboard/*` route, and no user JWT can reach
  `/v1/ingest/*`.
