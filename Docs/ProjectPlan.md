# Employee Computer Monitoring Application

## Project Plan & System Design — v1.0

**Prepared for:** Development Team / Engineering Lead
**Basis:** Technical Specification v1.0 (30-workstation, disclosed, company-owned-device deployment)
**Scope of this document:** Milestone-based delivery plan, system architecture, module/folder structure, and application of SOLID + modular design principles.

---

## 1. Guiding Design Philosophy

Before the plan, four decisions shape everything downstream:

1. **Three independently deployable components** — Agent, Server/API, Dashboard — communicating only through a versioned HTTPS contract. None may reach into another's internals or database directly.
2. **Ports & Adapters (Hexagonal) architecture** on the server. Business logic (attendance calculation, categorization, retention) is pure domain code that knows nothing about Postgres, Express/NestJS, or HTTP. Everything infrastructure-related is an adapter behind an interface.
3. **Strategy + Plugin pattern** for anything the spec labels "configurable" (categorization rules, retention policy, screenshot capture, alert rules) so Phase 3 "could-have" features slot in without touching Phase 1 code.
4. **Compliance as code, not as a memo** — transparency, retention, and audit-logging requirements from Section 3 of the spec are implemented as enforced architectural constraints (e.g., you _cannot_ add a data-access code path that skips the audit logger, because the repository layer is the only path to the DB and it wraps every read in an audit emitter).

---

## 2. High-Level System Architecture

```
┌───────────────────────┐        ┌────────────────────────┐        ┌──────────────────────┐
│   Monitoring Agent     │  HTTPS │      Server / API       │  SQL   │      Database          │
│  (30x Windows PCs)     │───────▶│  (stateless, horiz.     │───────▶│   PostgreSQL           │
│                        │◀───────│   scalable)             │◀───────│                        │
│  - Collectors          │  ACK/  │  - Auth & RBAC          │        │  employees, devices,   │
│  - Idle detector       │  cfg   │  - Ingestion API        │        │  activity_logs,        │
│  - Local queue (SQLite)│        │  - Categorization Engine│        │  attendance,           │
│  - Sync client         │        │  - Reporting Service    │        │  screenshots,          │
│  - Config puller       │        │  - Retention Job        │        │  categories, users,    │
└───────────────────────┘        │  - Audit Logger         │        │  audit_log             │
                                   └───────────┬────────────┘        └──────────────────────┘
                                               │ HTTPS (REST/JSON)
                                               ▼
                                  ┌────────────────────────┐
                                  │   Admin Dashboard       │
                                  │  (React SPA, browser)   │
                                  │  - Overview / drilldown │
                                  │  - Reports / export     │
                                  │  - Settings / user mgmt │
                                  └────────────────────────┘
```

**Data flow (matches spec §2.1):** Collectors buffer events in-process → flushed to a local SQLite queue every 1–5 min → Sync Client POSTs a batch to `/ingest` → API validates, authenticates the device token, writes through the domain layer → domain layer invokes Categorization + Audit as side effects → Dashboard reads only through the Reporting Service (never raw tables), which enforces RBAC and produces read-optimized aggregates.

### 2.1 Why this shape

- **Agent is offline-first by design**, not offline-tolerant as an afterthought: the local SQLite queue is the source of truth until the server ACKs a batch. This satisfies the "zero data loss" NFR directly in the architecture rather than as a retry hack.
- **Server is stateless** so it can scale horizontally past 30 agents to ~100+ without redesign (per NFR §10), with Postgres as the only shared state.
- **Categorization and Retention are background workers**, not inline request logic, so they can run on a schedule (cron/queue) independent of API request latency (keeps dashboard <3s per NFR §10).

---

## 3. Repository / Project Structure

Monorepo recommended for a 30-seat, single-team project (simplifies versioning the Agent↔Server contract).

```
employee-tracker/
├── Agent/                           # C#/.NET Windows Service
│   ├── src/
│   │   ├── Collectors/             # IActivityCollector implementations
│   │   │   ├── AppFocusCollector.cs
│   │   │   ├── UrlCollector.cs
│   │   │   ├── IdleStateCollector.cs
│   │   │   ├── UsbDeviceCollector.cs        (Phase 3)
│   │   │   └── ScreenshotCollector.cs       (Phase 3)
│   │   ├── Buffering/               # ILocalStore, SQLite-backed queue
│   │   ├── Sync/                    # ISyncClient, retry/backoff policy
│   │   ├── Config/                  # IAgentConfigProvider, remote config pull
│   │   ├── Attendance/              # login/logout session tracker
│   │   ├── Service/                 # Windows Service host, DI composition root
│   │   └── Program.cs
│   └── tests/
│       ├── Collectors.Tests/
│       └── Sync.Tests/
│
├── Backend/                          # Node.js (NestJS) API
│   ├── src/
│   │   ├── modules/                 # one module = one bounded context
│   │   │   ├── auth/                # login, JWT, 2FA, RBAC guards
│   │   │   ├── devices/             # device registration/token issuance
│   │   │   ├── ingestion/           # POST /ingest, batch validation
│   │   │   ├── activity/            # activity_logs domain + service
│   │   │   ├── attendance/          # attendance domain + service
│   │   │   ├── categorization/      # rule engine (Strategy pattern)
│   │   │   ├── screenshots/         # optional, feature-flagged
│   │   │   ├── reports/             # read-model aggregation, CSV/PDF export
│   │   │   ├── audit/               # audit_log writer + reader
│   │   │   ├── retention/           # scheduled purge job
│   │   │   └── users/               # admin/manager/auditor accounts
│   │   ├── common/                  # cross-cutting: interfaces, DTOs, guards,
│   │   │   │                        #   interceptors (audit interceptor lives here)
│   │   │   ├── interfaces/          # IRepository<T>, IClock, IFeatureFlags…
│   │   │   └── decorators/
│   │   ├── infrastructure/          # concrete adapters — the ONLY layer that
│   │   │   ├── postgres/            #   imports pg/typeorm/prisma
│   │   │   ├── storage/             #   screenshot file storage adapter
│   │   │   └── mailer/
│   │   └── main.ts
│   └── test/
│       ├── unit/                    # domain logic, no DB
│       ├── integration/             # module + test DB
│       └── contract/                # agent↔server payload contract tests
│
├── Frontend/                          # React SPA
│   ├── src/
│   │   ├── features/                 # overview/, employees/, reports/, settings/
│   │   ├── components/               # shared, presentational only
│   │   ├── api/                      # typed API client, one file per module
│   │   ├── store/                    # state slices per feature
│   │   └── App.tsx
│   └── tests/
│
├── shared/                           # shared TS types/DTOs (contract source of truth)
│   └── contracts/                    # e.g. ActivityBatchDto, AttendanceDto
│
├── infra/                            # IaC, CI/CD, MSI packaging, GPO scripts
│   ├── docker-compose.yml
│   ├── terraform/  (or Bicep, if Azure)
│   ├── installer/  (WiX/MSI project for Agent)
│   └── ci/
│
└── docs/
    ├── adr/                          # Architecture Decision Records
    ├── api-reference.md
    └── deployment-guide.md
```

**Note:** `Agent/`, `Backend/`, and `Frontend/` are capitalized as the three primary top-level directories per project convention; `shared/`, `infra/`, and `docs/` remain lowercase as supporting/cross-cutting directories. Adjust if you'd like a fully consistent casing scheme.

---

## 4. SOLID Principles — Applied, Not Just Named

| Principle                     | Where it shows up in this system                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S — Single Responsibility** | Each collector (`AppFocusCollector`, `UrlCollector`, `IdleStateCollector`) does exactly one kind of capture. Each server module owns exactly one bounded context — `AttendanceService` only computes attendance; it never touches categorization or screenshots.                                                                                                           |
| **O — Open/Closed**           | `CategorizationEngine` depends on `ICategorizationStrategy[]`. Adding a new rule type (e.g. a future ML-based classifier) means adding a new strategy class — zero changes to the engine or to callers. Same pattern for `IAlertRule` in Phase 3.                                                                                                                          |
| **L — Liskov Substitution**   | Any `IActivityCollector` can be swapped in/out of the agent pipeline without the buffering/sync code caring which one it is. Any `IActivityRepository` implementation (Postgres today, in-memory fake in tests, MySQL later) is interchangeable behind the domain services.                                                                                                |
| **I — Interface Segregation** | Instead of one fat `IMonitoringService`, the server exposes narrow interfaces: `IActivityWriter`, `IAttendanceReader`, `IAuditLogger`, `IReportQuery`. A module like `reports/` only depends on the read interfaces it actually needs, not on write/admin operations.                                                                                                      |
| **D — Dependency Inversion**  | Domain/service layer depends only on interfaces defined in `common/interfaces/`. Concrete DB clients, the file-storage SDK, and the mail library live exclusively in `infrastructure/` and are injected via the DI container (NestJS providers / .NET `IServiceCollection`). Swapping Postgres → MySQL, or local disk → S3 for screenshots, touches only one adapter file. |

**Illustrative sketch (not full implementation):**

```typescript
// common/interfaces/activity-repository.interface.ts
export interface IActivityRepository {
  saveBatch(deviceId: string, events: ActivityEvent[]): Promise<void>;
  queryRange(employeeId: string, from: Date, to: Date): Promise<ActivityEvent[]>;
}

// modules/categorization/categorization-engine.ts
export class CategorizationEngine {
  constructor(private strategies: ICategorizationStrategy[]) {}
  categorize(event: ActivityEvent): Category {
    for (const s of this.strategies) {
      const result = s.tryCategorize(event);
      if (result) return result;
    }
    return Category.Neutral;
  }
}
```

```csharp
// Agent/src/Collectors/IActivityCollector.cs
public interface IActivityCollector
{
    Task<IEnumerable<ActivityEvent>> CollectAsync(CancellationToken ct);
}
```

### Modularity rules enforced across the codebase

- No module imports another module's `infrastructure/` internals directly — only its public service interface.
- `shared/contracts/` is the single source of truth for the Agent↔Server payload shape; both sides generate/validate against it, preventing drift.
- Feature flags (screenshots, USB logging, alerts, activity-score) are read through one `IFeatureFlags` interface so every optional feature in the spec (§4, Priority S/C) can be toggled without conditional logic scattered through the codebase.

---

## 5. Data Model (refined from spec §7)

Core tables carried over from the spec, with relationships made explicit:

- `employees (1) ── (many) devices`
- `devices (1) ── (many) activity_logs`
- `employees (1) ── (many) attendance` (one row per employee per day)
- `devices (1) ── (many) screenshots` (nullable path; empty table if feature disabled)
- `categories` — admin-editable pattern→category mapping, read by the Categorization Engine
- `users (1) ── (many) audit_log` entries
- Recommended additions: index `activity_logs(device_id, start_time)` for timeline queries; index `attendance(employee_id, date)`; a `feature_flags` table so retention/screenshot/USB toggles are data, not redeploys.

---

## 6. API Surface (skeleton)

| Endpoint                         | Method | Consumer                  | Purpose                                                     |
| -------------------------------- | ------ | ------------------------- | ----------------------------------------------------------- |
| `/api/v1/devices/register`       | POST   | Agent (install-time)      | Exchange install token for a per-device auth token          |
| `/api/v1/ingest`                 | POST   | Agent                     | Batched activity/idle/attendance events                     |
| `/api/v1/config`                 | GET    | Agent                     | Pull current work-hours, screenshot interval, feature flags |
| `/api/v1/auth/login`             | POST   | Dashboard                 | Manager/HR/Admin login (JWT)                                |
| `/api/v1/employees`              | GET    | Dashboard                 | Roster + today's snapshot                                   |
| `/api/v1/employees/:id/timeline` | GET    | Dashboard                 | Drill-down view                                             |
| `/api/v1/reports`                | GET    | Dashboard                 | Filtered reports, CSV/PDF export                            |
| `/api/v1/settings/categories`    | PUT    | Dashboard (Admin)         | Edit productivity rules                                     |
| `/api/v1/audit-log`              | GET    | Dashboard (Admin/Auditor) | Access history                                              |

All routes behind RBAC guards mapped to the three roles in spec §6 (Super Admin / Manager-HR / Auditor).

---

## 7. Milestone-Based Delivery Plan

Assumes a small team (2 backend/agent engineers, 1 frontend, shared QA/PM). Durations are working-week estimates for a 30-seat v1.0 — adjust to your actual team size and velocity.

| Milestone                            | Deliverable                                                                                                                                           | Maps to spec      | Est. duration |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------- |
| **M0 — Foundations**                 | Monorepo scaffolded, CI/CD pipelines, coding standards, ADR template, shared contract package, Postgres schema migration tooling                      | §7, §8            | 1 week        |
| **M1 — Core Agent**                  | App/URL/idle collectors, local SQLite buffer, sync client with retry/backoff, Windows Service host, auto-start & crash recovery                       | §4 (M items), §10 | 2 weeks       |
| **M2 — Server Core & Ingestion**     | Auth (device token + JWT), `/ingest` endpoint, activity/attendance domain services, Postgres persistence via repository interfaces                    | §2, §4, §9        | 2 weeks       |
| **M3 — Dashboard MVP**               | Login, RBAC-gated routes, Overview screen, Employee list, per-employee timeline (reads real data from M2)                                             | §5, §6            | 2 weeks       |
| **M4 — Reporting & Categorization**  | Categorization Engine (strategy-based), team/individual rollups, CSV/PDF export, date-range/department filters                                        | §4, §5            | 1.5 weeks     |
| **M5 — Roles, Audit & Retention**    | Full RBAC (3 roles), audit-log interceptor on every data-access path, configurable retention job, admin settings UI                                   | §3.1, §6, §9      | 1.5 weeks     |
| **M6 — Optional Features (Phase 3)** | Screenshots (toggleable, encrypted at rest), activity-score metric, USB device logging, basic alert rules                                             | §4 (S/C items)    | 2 weeks       |
| **M7 — Security Hardening**          | TLS enforcement, bcrypt/argon2 verification, rate limiting, input validation pass, dependency/security audit, 2FA for admins                          | §9                | 1 week        |
| **M8 — Packaging & Deployment**      | MSI installer, silent/GPO-scriptable rollout, config-at-install-time, uninstaller + rollback doc, agent auto-update mechanism                         | §11               | 1 week        |
| **M9 — UAT & Pilot Rollout**         | Deploy to a handful of pilot PCs, validate reboot/network-drop survival, dashboard accuracy check against spec's acceptance criteria, sign-off        | §13               | 1 week        |
| **M10 — Full Rollout & Handover**    | All 30 agents live, deployment guide + admin guide + API reference delivered, monitoring policy acknowledgement process confirmed with business owner | §13               | 0.5 week      |

**Total: ~14.5 weeks** for a small team, sequential-with-some-overlap (Agent and Server tracks in M1/M2 can run in parallel; Dashboard M3 can start once M2's contract is frozen at end of M0).

### Milestone gating (acceptance criteria per spec §13)

- M1/M2 don't close until: an agent survives a forced reboot and a simulated network drop with zero data loss.
- M4/M5 don't close until: dashboard reports load in <3s for a 30-person dataset (per NFR §10) and every dashboard read passes through the audit logger.
- M6 doesn't close until: screenshots and activity-score can be fully disabled by an admin with no residual capture.
- M9 doesn't close until: legal/compliance checklist below is signed off by the business owner.

---

## 8. Compliance Checklist (build-time, tracked as its own workstream)

- [ ] Written monitoring policy drafted and employee acknowledgement flow built into onboarding
- [ ] Agent has a visible indicator / appears in installed programs (no stealth behavior — verified in M7 review)
- [ ] Screenshot and keystroke-content capture confirmed absent from codebase (code review checklist item, every PR touching `Collectors/`)
- [ ] Retention purge job tested against configured windows (30/60/90 days)
- [ ] Access audit log verified to capture every dashboard read, not just writes
- [ ] Data residency / PDPA / GDPR review completed with legal counsel before go-live (business owner action item, not engineering)

---

## 9. Risk Register (top items)

| Risk                                                  | Impact                    | Mitigation                                                                                                 |
| ----------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent/Server contract drift                           | Breaks ingestion silently | Shared `contracts/` package + contract tests in CI                                                         |
| Screenshot storage costs/size at scale                | Disk/DB bloat             | Store screenshots on disk/object storage with only a path in DB; retention job prunes files, not just rows |
| Feature creep on "could-have" items delaying core MVP | Slips M1–M3               | Phase gates strictly enforced; M6 items only start after M5 closes                                         |
| Legal/compliance sign-off delay                       | Blocks go-live            | Compliance checklist (Section 8) run in parallel from M0, not left to the end                              |

---

## 10. Suggested Tech Stack (finalized from spec §8 recommendations)

- **Agent:** C#/.NET, Windows Service, SQLite for local buffering
- **Server:** Node.js + NestJS (module system maps directly to Section 3/4 above), Postgres, TypeORM/Prisma
- **Dashboard:** React + TypeScript, a lightweight state library (Zustand/Redux Toolkit)
- **Auth:** JWT for dashboard sessions, per-device tokens for agents, bcrypt/argon2, optional TOTP 2FA for admins
- **Infra:** Docker Compose for local/dev parity, Terraform/Bicep for the server VM, WiX for the MSI installer
- **CI/CD:** GitHub Actions — lint/test on PR, contract tests gating merges that touch `shared/contracts/`

---

_This plan operationalizes the v1.0 technical specification into buildable increments. Confirm milestone durations against actual team size before committing to a delivery date, and keep the compliance checklist (Section 8) as a standing item reviewed at the end of every milestone, not just before launch._
