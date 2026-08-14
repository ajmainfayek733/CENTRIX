# Backend - monitoring API

Express + Prisma + PostgreSQL. Port 5000. The system of record for telemetry, policy, identity
and audit.

**Documentation lives in [`../Docs/backend/`](../Docs/backend/).**

| Document | Contents |
|---|---|
| [../Docs/backend/README.md](../Docs/backend/README.md) | Module layout, request lifecycle, where to add code |
| [../Docs/backend/ingest.md](../Docs/backend/ingest.md) | The agent write path |
| [../Docs/backend/reporting.md](../Docs/backend/reporting.md) | The dashboard read path |
| [../Docs/backend/realtime.md](../Docs/backend/realtime.md) | Socket.IO signalling |
| [../Docs/backend/security.md](../Docs/backend/security.md) | Auth, RBAC, rate limiting, audit |
| [../Docs/reference/data-model.md](../Docs/reference/data-model.md) | Tables and indexes |
| [../Docs/operations/backend-deployment.md](../Docs/operations/backend-deployment.md) | Deployment and fleet onboarding |
| [../Docs/README.md](../Docs/README.md) | Documentation index for the whole system |

```bash
cp .env.example .env          # DATABASE_URL, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
npx prisma migrate dev
npm run seed                  # prints the enrollment token ONCE
npm run dev                   # http://localhost:5000
npm test                      # integration smoke against the real database
```

Start this before `Frontend/` and before installing the agent. Full instructions:
[../Docs/operations/running-the-stack.md](../Docs/operations/running-the-stack.md).
