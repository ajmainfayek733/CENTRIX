# Running the stack locally

Three tiers, and they must start **in this order**. The dashboard renders server-side against the
API, and the agent cannot enroll until the backend has an organization with an enrollment token.

Requires: .NET 10 SDK, Node 20+, PostgreSQL installed locally (installed manually - not via
winget or Docker in this project).

---

## 1. Backend - port 5000

```bash
cd Backend
cp .env.example .env          # set DATABASE_URL, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
npx prisma migrate dev
npm run seed                  # prints the enrollment token - SAVE IT
npm run dev                   # http://localhost:5000
```

**`npm run seed` prints the agent enrollment token exactly once.** Only its HMAC is persisted, so
it cannot be recovered afterwards - if you lose it, rotate with
`POST /v1/dashboard/organizations/:id/enrollment-token`.

Verify:

```bash
curl http://localhost:5000/health     # {"status":"ok",...}
```

A 503 with `reason: "database unreachable"` means the process is up but Postgres is not
answering - check `DATABASE_URL`.

## 2. Frontend - port 3000

```bash
cd Frontend
cp .env.example .env.local    # MONITORING_API_URL=http://localhost:5000
npm run dev                   # http://localhost:3000
```

Sign in with the seeded account: `admin@example.com` / `ChangeMe123!` unless overridden.

Two environment variables, and they are **not** interchangeable:

| Variable | Read by | Must be reachable from |
|---|---|---|
| `MONITORING_API_URL` | Next.js server | The server |
| `NEXT_PUBLIC_MONITORING_API_URL` | Browser (socket) | The user's browser |

Setting only the first leaves the socket pointed at `http://localhost:5000` from the user's
machine, which works locally and fails everywhere else.

## 3. Agent

From an **elevated** PowerShell:

```powershell
cd "Windows Software_v3"
.\scripts\Deploy-Agent.ps1 -Action Install `
    -ServerUrl http://localhost:5000 `
    -EnrollmentToken <token from npm run seed> `
    -AllowInsecureHttp
```

`-AllowInsecureHttp` is for local testing only. The service refuses a plain-HTTP server address
without it, because the spec requires TLS in production.

The enrollment token is **org-wide**: the same token goes into every install, and each agent
trades it once for its own per-device API key. There is no per-machine provisioning step.

After install the device appears on the **Devices** screen as *Unassigned*. **It will not appear
in any per-employee report until an admin assigns it.** That step is not cosmetic.

Other actions: `-Action Status`, `-Action Publish`, `-Action Uninstall [-PurgeData]`.

---

## Verifying it works end to end

1. `curl http://localhost:5000/health` returns `ok`.
2. Dashboard loads and you can sign in.
3. Devices screen shows the workstation, and it goes green within one heartbeat interval (~30s).
4. Assign the device to an employee.
5. Use the workstation for a few minutes; the employee's detail screen shows activity sessions
   after the next sync (~2 min at defaults).

If step 5 does not happen, work through
[troubleshooting.md](troubleshooting.md) section 1 - it is almost always the assignment in step 4
or a host process that is not running.

## Tests

```bash
cd Backend && npm test        # integration smoke against the real database
```

Not a unit suite - it exercises enrollment, auth boundaries, per-channel validation, column-level
persistence, idempotency and the device kill switch. It is what catches a broken wire contract.

## Running two frontends at once

`next dev` refuses to start a second server in the same directory. Build and use `next start`:

```bash
npm run build
MONITORING_API_URL=http://127.0.0.1:5999 npx next start -p 3099
```

This is also how the degraded-service behaviour is verified - see
[../frontend/resilience.md](../frontend/resilience.md).

## Docker

```bash
cp .env.example .env          # repo root
docker compose up -d --build
```

Three services: `postgres`, a one-shot `migrate` (separate so migrations do not race when `api`
is scaled), and `api`. Postgres is not published to the host by default.

---

## Related

- [backend-deployment.md](backend-deployment.md) - production and fleet onboarding
- [agent-deployment.md](agent-deployment.md) - rolling the agent out properly
- [troubleshooting.md](troubleshooting.md) - when a step above does not work
- [../reference/configuration.md](../reference/configuration.md) - every environment variable
