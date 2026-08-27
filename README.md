# Employee Tracker

An in-office CENTRIXing system for company-owned Windows workstations: a native agent
collects activity, an Express/PostgreSQL backend stores it, and a Next.js dashboard reports on it.

**All documentation lives in [`Docs/`](Docs/). Start at [Docs/README.md](Docs/README.md).**

---

## The three tiers

| Tier | Directory | Stack | Port | Docs |
|---|---|---|---|---|
| Backend | `Backend/` | Express + Prisma + PostgreSQL | 5000 | [Docs/backend/](Docs/backend/) |
| Dashboard | `Frontend/` | Next.js App Router | 3000 | [Docs/frontend/](Docs/frontend/) |
| Agent | `Windows Software_v3/` | .NET 10, WPF, SYSTEM service + user host | - | [Docs/agent/](Docs/agent/) |

They must start **in that order**: the dashboard renders server-side against the API, and the
agent cannot enroll until the backend has an organization with an enrollment token. See
[Docs/operations/running-the-stack.md](Docs/operations/running-the-stack.md).

> `Agent/` and `Windows Software/` are **abandoned** earlier attempts at the Windows client.
> Nothing live depends on them, and their documentation is archived in
> [Docs/archive/](Docs/archive/). Do not build on either.

## Quick start

```bash
# 1. Backend
cd Backend && cp .env.example .env && npx prisma migrate dev && npm run seed && npm run dev

# 2. Dashboard
cd Frontend && cp .env.example .env.local && npm run dev

# 3. Agent (elevated PowerShell)
cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install -ServerUrl http://localhost:5000 `
    -EnrollmentToken <token from npm run seed> -AllowInsecureHttp
```

`npm run seed` prints the enrollment token **once**. Seeded login: `admin@example.com` /
`ChangeMe123!`.

Full instructions and verification steps:
[Docs/operations/running-the-stack.md](Docs/operations/running-the-stack.md).

## Where to look

| I want to... | Go to |
|---|---|
| Understand the system | [Docs/architecture/system-overview.md](Docs/architecture/system-overview.md) |
| Fix a bug or an outage | [Docs/operations/troubleshooting.md](Docs/operations/troubleshooting.md) |
| Find the logs | [Docs/operations/diagnostics.md](Docs/operations/diagnostics.md) |
| Look up an endpoint | [Docs/reference/](Docs/reference/) |
| Change something across tiers | [Docs/architecture/cross-tier-contracts.md](Docs/architecture/cross-tier-contracts.md) |

Contributor rules are in [CLAUDE.md](CLAUDE.md).

---

## API response conventions

Dashboard endpoints (`/v1/dashboard/*`) use an envelope:

```json
{ "status": "success", "message": "success note", "data": "response data" }
```

```json
{ "status": "error", "message": "error note" }
```

| Code | Meaning |
|---|---|
| 200 | Successful GET/PATCH/PUT/DELETE |
| 201 | Successful POST that inserted a row |
| 400 | Bad request |
| 401 | Unauthorized |
| 403 | Forbidden - authenticated but not permitted, or deactivated |
| 404 | Not found |
| 500 | Internal server error |

Agent endpoints (`/api/v1/*`) do **not** use this envelope - see
[Docs/reference/agent-api.md](Docs/reference/agent-api.md).

## Branching

| Branch | Purpose |
|---|---|
| `main` | Production. `dev` merges here after final testing |
| `dev` | Feature branches merge here for final testing |
| `docs` | Documentation-only changes |
| `feat/<name>` | One branch per feature |

## Commit messages

```text
<type>(<scope>)/ <description>
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `revert`, `build`, `ci`,
`chore`

**Scopes:** `auth`, `user`, `docs`, `chart`, `org`, `db`, `api`, `ui`, `form`, `config`, `deps`,
`email`, `payment`, `etl`

Example:

```text
feat(auth)/ login with JWT
```
