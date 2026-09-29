# Backend deployment & fleet onboarding

How to stand this backend up, and how to get 30-100+ workstations enrolled and attributed to
people once it is running.

---

## 1. Fleet onboarding

**The enrollment token is org-wide, not per-device.** One token goes into every install; there is
no per-machine provisioning step.

### Order of operations

1. **Create the organization.** Open `/ems/advanced/register-organization` on the dashboard (this
   route is not linked from the UI) or `POST /v1/dashboard/organizations/register`. The response
   includes the enrollment token **once**. Store it - only its HMAC is persisted, and agents need
   it to register organization devices. Authenticated `POST /v1/dashboard/organizations` also
   mints a token for an additional tenant.
2. **Import the roster.** Employees screen -> *Import roster* -> paste
   `name, email, department` (one per line). Tab-separated text pasted straight from a
   spreadsheet works, a header row is ignored, and re-importing a file that already contains
   existing people skips them rather than failing. Do this before the rollout so devices have
   somewhere to be assigned.
3. **Roll the agent out** with the same token on every machine:
   ```powershell
   .\Deploy-Agent.ps1 -Action Install `
       -ServerUrl https://monitoring.example.com `
       -EnrollmentToken $env:ENROLL_TOKEN
   ```
   Push via GPO startup script, Intune, or PDQ. The script is unattended-safe and idempotent.
4. **Assign each device.** Devices screen -> the *Assigned to* column is a dropdown. Until a
   device is assigned it sits on the hidden "Unassigned Devices" placeholder: its telemetry is
   stored but never reaches per-employee reports, so this step is not cosmetic.

### What happens on the wire

Each agent trades the org token for its **own** 32-byte API key, stored DPAPI-protected on the
workstation. Only the key's HMAC is persisted server-side. The org token is never used again on
that machine.

Two properties worth knowing:

- **Re-enrollment is idempotent on MachineGuid and preserves the employee assignment.** A
  re-imaged or reinstalled workstation gets a fresh key and keeps its person - no admin action.
- **The kill switch survives reinstall.** A deactivated device gets 403 at enrollment, so
  reinstalling is not a way around deactivation.

### Token rotation

`POST /v1/dashboard/organizations/:id/enrollment-token` issues a new token; already-issued device
keys keep working. The cost: every `agent.config.json` in the fleet now holds a stale token, so
any machine that later loses `device.key` cannot re-enroll until you push a new config. Rotate
after rollout if you want to limit the shared secret's exposure, but plan to redistribute config.

---

## 2. Running it

### Docker (recommended - deployment target stays portable)

```bash
cp .env.example .env      # repo root; fill in POSTGRES_PASSWORD, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
docker compose up -d --build
```

Three services: `postgres`, a one-shot `migrate` (kept separate so migrations do not race when
`api` is scaled), and `api`. Postgres is not published to the host by default.

### Without Docker

```bash
npm ci
npx prisma migrate deploy
npm run build
npm start
```

`npm run build` compiles to `dist/` and writes `dist/package.json` marking it CommonJS - the root
package is `"type": "module"` while tsconfig emits CommonJS, so without that marker Node refuses
to load the output.

---

## 3. Configuration that depends on where you deploy

Everything is environment-driven; see `.env.example` for the full list. Three settings genuinely
depend on the topology:

### `TRUST_PROXY`

**Set this correctly or per-IP rate limiting breaks in one direction or the other.**

| Deployment | Value |
|---|---|
| Container/process exposed directly | `false` (default) |
| Behind one reverse proxy (nginx, Traefik, ALB) | `1` |
| Behind a CDN in front of a proxy | `2` |

Too low behind a proxy: every request appears to come from the proxy, so the per-IP backstop
collapses onto a single bucket. Too high (or `true` with no proxy): clients can forge
`x-forwarded-for` and dodge limits entirely.

### `DATABASE_POOL_MAX`

Default 10. Raise it if agents sync in bursts and requests queue behind the pool. If you run
several `api` replicas, divide your database's own connection ceiling between them.

### `SCREENSHOT_STORAGE_DIR`

Local filesystem, on a named volume under compose. **This is what blocks horizontal scaling:**
with more than one replica each holds a different subset of images, so the dashboard 404s
whichever replica it asks. Before scaling out, either point this at shared storage (NFS/EFS) or
replace `screenshotStorage.ts` with an S3/Azure Blob backend - the module is deliberately a
two-function surface so the swap is contained.

### EmailJS and `FRONTEND_URL`

Password recovery emails go out through EmailJS. Set `EMAILJS_SERVICE_ID`,
`EMAILJS_PASSWORD_RESET_TEMPLATE_ID`, `EMAILJS_PUBLIC_KEY` and `EMAILJS_PRIVATE_KEY`, and enable
non-browser API access in the EmailJS account. Without them the API still starts, but
`/forgot-password` returns 503. `FRONTEND_URL` must be the public dashboard URL, because reset
links are built from it. Setup and template: [../backend/password-recovery.md](../backend/password-recovery.md).

---

## 4. Rate limits and how they are keyed

The keys matter more than the numbers, because an office of 100 machines usually shares one
public IP.

| Route | Limit | Keyed by |
|---|---|---|
| `POST /api/v1/device/enroll` | `RATE_LIMIT_ENROLL_PER_MIN` (10) | **MachineGuid** |
| `POST /api/v1/events/:channel` | `RATE_LIMIT_INGEST_PER_MIN` (200) | device (post-auth) |
| `POST /api/v1/screenshots` | `RATE_LIMIT_SCREENSHOT_PER_MIN` (60) | device (post-auth) |
| everything under `/api/v1` | `RATE_LIMIT_UNAUTHENTICATED_PER_MIN` (3000) | IP, pre-auth backstop |
| dashboard login/register | 10 | IP |

Enrollment is keyed on the MachineGuid in the request body, not the source address. The point of
limiting enrollment is to stop one machine hammering the credential-minting endpoint - not to cap
how many *distinct* machines may join per minute. Keyed by IP, a simultaneous rollout behind one
NAT would have allowed 10 enrollments per minute for the entire company.

Authenticated limits are keyed per device for the same reason: one busy workstation must not
throttle its ninety-nine neighbours.

**Scope:** counters are per-process, in memory. That is correct for a single instance. Run
multiple replicas and each enforces its own budget, so the effective limit multiplies by the
replica count - an accepted trade for not requiring Redis, since these limits exist to contain a
stuck agent rather than to meter anything.

---

## 5. Load expectations

One agent, at defaults: a heartbeat every ~5 min, an events push every ~2 min across six channels,
and an optional screenshot every 10 min. A hundred agents is on the order of a few requests per
second - the pool and the ingest write path are the things to watch, not request throughput.

Two behaviours already protect the server under a recovering fleet:

- Agents upload **sequentially**, never in parallel, and screenshots one at a time.
- On failure they back off **exponentially** (5s -> capped), which prevents a hundred workstations
  from retrying in lockstep through an outage and then reconnecting simultaneously.

---

## Related

- [running-the-stack.md](running-the-stack.md) - local development
- [agent-deployment.md](agent-deployment.md) - the workstation side of onboarding
- [troubleshooting.md](troubleshooting.md) - when a deployment misbehaves
- [../reference/configuration.md](../reference/configuration.md) - every environment variable
- [../backend/security.md](../backend/security.md) - how the limits above are keyed
