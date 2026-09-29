# AWS deployment (EC2 + S3, Mumbai)

Production runbook for the dashboard and API on a single x86_64 Linux EC2 host in
**ap-south-1 (Asia Pacific, Mumbai)**, with screenshots in S3. Every file referenced here lives in
[`deploy/`](../../deploy/).

---

## 1. Architecture

```text
                 EC2 t3a.medium (Ubuntu 24.04 x86_64, Elastic IP)
              +-------------------------------------------------------------+
 Browser  --> | caddy (https://DOMAIN)                                      |
 Agents   --> |   /api/v1/*  /socket.io/*  /health  --> api:5000           |
              |   everything else                    --> frontend:3000      |
              |                                            |                |
              |   api --> postgres:5432 (container, EBS)   | (private net)  |
              |   frontend --> http://api:5000 ------------+                |
              +---------|---------------------------------------------------+
                        +--> S3 bucket (screenshots, DB backups), instance role
```

### URL layout on the single domain

| Path | Served by | Used by |
|---|---|---|
| `https://DOMAIN/` and all pages | Dashboard | Managers in the browser |
| `https://DOMAIN/api/auth/*`, `/api/reports/*`, `/api/screenshots/*`, `/api/logs/*`, `/api/realtime/*`, `/api/health` | Dashboard | The dashboard's own server routes (login, PDF export, screenshot viewing) |
| `https://DOMAIN/api/v1/*` | API | Windows agents: enroll, telemetry, screenshots, policy |
| `https://DOMAIN/socket.io/*` | API | Live updates for agents and the browser |
| `https://DOMAIN/health` | API | API and database health probe |

**Agents are installed with `-ServerUrl https://DOMAIN`, not `https://DOMAIN/api`.** The agent
appends `api/v1/...` itself, and its realtime client treats any path in the URL as a namespace
name. Given `.../api`, it would ask for a namespace that does not exist, and live commands would
silently stop working.

The dashboard's own login and report routes also start with `/api`. That is why only `/api/v1`
goes to the API rather than all of `/api`. The API's remaining routes, Better Auth and
`/v1/dashboard`, are called only by the dashboard server over the private Docker network and
are not exposed.

| Decision | Reason |
|---|---|
| Caddy for TLS | Issues and renews Let's Encrypt certificates automatically; proxies WebSockets without extra config |
| Same origin for dashboard and API | No CORS preflights, and one certificate |
| Instance role for S3 | No long-lived keys on disk. Requires IMDS hop limit 2 (section 3.2) |
| Postgres in a container by default | Cheapest option. Switch to RDS by changing two values (section 7) |
| Migrations as a one-shot service | Run before the API starts. A failed migration leaves the previous API running |
| AMD `t3a` over Intel `t3` | Same 2 vCPU / 4 GiB, x86_64, about 45 percent cheaper in Mumbai |

---

## 2. Prerequisites

- An AWS account and the AWS CLI v2 on your workstation. AWS CloudShell also works.
- The domain, with access to its DNS records.

---

## 3. Provision AWS resources (region ap-south-1)

### 3.1 EC2 instance

| Setting | Value |
|---|---|
| Region | Asia Pacific (Mumbai) `ap-south-1` |
| AMI | Ubuntu Server 24.04 LTS, **64-bit (x86)** |
| Type | `t3a.medium` (AMD, 2 vCPU, 4 GiB). `t3.medium` is the Intel equivalent at a higher price |
| Root volume | 30 GiB gp3, encrypted |
| Security group inbound | TCP 80, TCP 443 and UDP 443 (HTTP/3) from `0.0.0.0/0` |
| SSH | Not needed. Use SSM Session Manager, which the role grants. If you open 22, restrict it to your office IP |
| Elastic IP | Allocate and associate one, so the address survives stop and start |

### 3.2 S3 bucket and instance role

From your workstation, with the instance ID from step 3.1:

```bash
AWS_REGION=ap-south-1 \
BUCKET=centrix-screenshots-yourcompany \
INSTANCE_ID=i-0123456789abcdef0 \
  ./deploy/aws/setup-s3-and-iam.sh
```

The script is idempotent and does the following:

- **Creates the bucket.** Public access is blocked, ACLs are disabled, SSE-S3 encryption is on, and non-TLS requests are denied.
- **Adds lifecycle rules.** Screenshots move to Standard-IA after 30 days. Database backups expire after 14 days. Incomplete uploads are aborted.
- **Creates the `centrix-ec2-role` role.** It can put and get objects in this bucket only, and it grants SSM Session Manager.
- **Attaches the role to the instance.** It also sets IMDSv2 to required with hop limit 2.

> **Hop limit 2 is not optional.** Containers are one network hop behind the host. At the
> default of 1, the AWS SDK inside the API container gets no credentials and every screenshot
> upload fails with `CredentialsProviderError`.

### 3.3 DNS

At your DNS provider, point an **A record for the domain** at the Elastic IP. Wait until
`dig +short DOMAIN` returns the Elastic IP before the first start, or certificate issuance fails
and Caddy retries with backoff.

To also serve `www.DOMAIN`, add its A record, then add this site block to `deploy/Caddyfile`:

```text
www.{$DOMAIN} {
	redir https://{$DOMAIN}{uri} permanent
}
```

---

## 4. First deployment

Connect with Session Manager (`aws ssm start-session --target i-... --region ap-south-1`) or SSH:

```bash
sudo -i -u ubuntu
git clone <repository-url> centrix && cd centrix
sudo ./deploy/scripts/ec2-bootstrap.sh
exit   # log out and back in so the docker group applies
```

```bash
cd ~/centrix/deploy
cp .env.example .env && chmod 600 .env
openssl rand -hex 32   # run three times: POSTGRES_PASSWORD, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
nano .env              # DOMAIN, ACME_EMAIL, SCREENSHOT_S3_BUCKET, BACKUP_S3_URI, the three secrets
./scripts/deploy.sh
```

`deploy.sh` refuses to start on empty or short secrets, a placeholder domain, or a `DOMAIN` that
contains `https://` or a path. It then builds both images, runs migrations, and waits for health.
Last, it checks `https://DOMAIN/health` for the API and `https://DOMAIN/api/health` for the
dashboard, which confirms both sides of the path routing.

> **Back up `DEVICE_TOKEN_PEPPER` outside the host** in a password manager. Losing it
> invalidates every enrolled agent's key and forces the whole fleet to re-enroll.

### 4.1 Create the organization and install agents

1. Open `https://DOMAIN/ems/advanced/register-organization`, then store the enrollment token it shows once.
2. Install agents with the bare domain:
   ```powershell
   .\Deploy-Agent.ps1 -Action Install -ServerUrl https://DOMAIN -EnrollmentToken $env:ENROLL_TOKEN
   ```
   Continue with [backend-deployment.md](backend-deployment.md) section 1.

### 4.2 Verify

```bash
curl -fsS https://DOMAIN/health         # API: {"status":"ok",...} proves API + database
curl -fsS https://DOMAIN/api/health     # dashboard process
docker compose -f deploy/docker-compose.prod.yml ps
```

Then confirm S3 end to end. After an agent uploads its first screenshot, it must open in the
dashboard, and `aws s3 ls s3://BUCKET/ --recursive | head` must list it.

---

## 5. Day-2 operations

| Task | Command (from the repository root) |
|---|---|
| Deploy a new version | `git pull && ./deploy/scripts/deploy.sh` |
| Roll back | `IMAGE_TAG=<previous short sha> docker compose --env-file deploy/.env -f deploy/docker-compose.prod.yml up -d` |
| Logs | `docker compose -f deploy/docker-compose.prod.yml logs -f --tail=200 api` |
| Restart one service | `docker compose -f deploy/docker-compose.prod.yml restart api` |
| Database shell | `docker compose -f deploy/docker-compose.prod.yml exec postgres psql -U centrix centrix` |

Images are tagged with the git commit, so earlier builds stay on the host for rollback until
`docker image prune -a` removes them. Rolling back past a migration requires restoring a backup,
because Prisma migrations only move forward.

The API drains in-flight requests on `SIGTERM`, so a deploy does not cut off screenshot uploads.
Agents queue locally during the seconds the API restarts.

### 5.1 Backups

**Database dumps to S3.** Nightly, streamed with no local copy:

```bash
crontab -e
# 21:00 UTC = 02:30 IST
0 21 * * * /home/ubuntu/centrix/deploy/scripts/backup-postgres.sh >> /home/ubuntu/backup.log 2>&1
```

Restore into the running container:

```bash
aws s3 cp s3://BUCKET/backups/postgres/centrix-YYYYMMDDTHHMMSSZ.dump - \
  | docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
      pg_restore -U centrix -d centrix --clean --if-exists --no-owner
```

**EBS snapshots.** Create an Amazon Data Lifecycle Manager policy for the instance's volume,
daily with 7 retained. This covers the Caddy certificates and anything else on disk.

Screenshots need no backup job, because S3 stores each object redundantly across availability
zones.

---

## 6. Monthly cost estimate (ap-south-1)

Unit prices are AWS on-demand list prices for Mumbai, read from AWS's public price list on
2026-09-29. Totals exclude tax (GST) and domain registration.

### Assumptions

| Input | Value | Source |
|---|---|---|
| Employees / agents | 100 | Upper end of the sizing the defaults target |
| Screenshot interval | 10 minutes | Policy default `screenshotIntervalSeconds = 600` |
| Screenshot size | ~200 KB | JPEG quality 70 at 1080p |
| Working time | 8 h/day, 22 days/month | |
| Screenshots per month | ~105,600 (~21 GB) | 100 x 48 per day x 22 |

### Unit prices used

| Item | Mumbai price |
|---|---|
| EC2 t3a.medium (AMD) | $0.0246/h |
| EC2 t3.medium (Intel) | $0.0448/h |
| EBS gp3 | $0.0912/GB-month |
| EBS snapshots | $0.05/GB-month |
| Public IPv4 address | $0.005/h |
| S3 Standard | $0.025/GB-month |
| S3 Standard-IA | $0.0138/GB-month |
| S3 PUT requests | $0.005 per 1,000 |
| S3 lifecycle transition to IA | $0.01 per 1,000 |
| RDS PostgreSQL db.t3.micro, Single-AZ | $0.026/h |
| RDS gp3 storage, Single-AZ | $0.131/GB-month |

### Recommended setup: everything on one t3a.medium

| Item | Calculation | Month 1 | Month 12 |
|---|---|---|---|
| EC2 t3a.medium | $0.0246/h x 730 h | $17.96 | $17.96 |
| EBS gp3 root, 30 GB | 30 x $0.0912 | $2.74 | $2.74 |
| Public IPv4 (Elastic IP) | $0.005/h x 730 h | $3.65 | $3.65 |
| EBS snapshots (7 daily) | ~10 GB changed data x $0.05 | $0.50 | $0.50 |
| S3 screenshots | Month 1: 21 GB Standard. Month 12: 21 GB Standard + 232 GB Standard-IA | $0.53 | $3.73 |
| S3 PUT requests | 105,600 x $0.005 per 1,000 | $0.53 | $0.53 |
| S3 transitions to IA | 105,600 x $0.01 per 1,000, from month 2 | $0.00 | $1.06 |
| S3 database backups | 14 dumps under 1 GB each | $0.30 | $0.30 |
| Data transfer out | Dashboard traffic stays inside the 100 GB/month free allowance | $0.00 | $0.00 |
| Route 53 hosted zone | Only if DNS is hosted in Route 53 | $0.50 | $0.50 |
| **Total** | | **~$27** | **~$31** |

**On Intel t3.medium instead**, the EC2 line is $32.70. That makes the total about **$42 in
month 1 and $46 in month 12**.

**With a 1-year Savings Plan or Reserved Instance**, the instance line typically drops 35 to 40
percent. The total then falls to roughly **$20 to $24**. Confirm the exact commitment price in
the EC2 console before purchasing.

At 50 employees the S3 lines halve. The total barely changes, because the instance is most of the
bill.

### Alternative: managed database (Amazon RDS)

| Item | Month 1 |
|---|---|
| EC2 t3a.small (2 GiB; Postgres moved off the host) | $8.98 |
| RDS db.t3.micro Single-AZ + 20 GB gp3, 7-day automated backups | $21.60 |
| EBS 20 GB + Elastic IP + S3 + Route 53 | ~$7.10 |
| **Total** | **~$38** |

This costs about $11 more per month. In exchange you get point-in-time recovery and managed
patching. A Multi-AZ RDS instance roughly doubles the RDS line. A 2 GiB host builds the dashboard
image slowly and relies on swap during `next build`.

### What moves the bill

- **Instance size and type.** The instance is about two thirds of the total. Check `docker stats` before resizing.
- **Screenshot interval.** Halving the interval doubles S3 growth, which is still only cents per month at this scale.
- **Data transfer.** Past 100 GB/month out, AWS charges for internet egress. Only heavy screenshot browsing reaches that.

---

## 7. Switching to RDS

> **Not wired up or tested.** The bundled Postgres is the supported path for the first
> deployment. The stack does not yet include the RDS certificate authority, and the Postgres
> driver treats `sslmode=require` as full certificate verification. A connection using the URL
> below fails with a self-signed certificate error until the AWS global RDS CA bundle is
> mounted into the `api` and `migrate` services and `NODE_EXTRA_CA_CERTS` points at it.

1. Create a PostgreSQL 17 RDS instance in ap-south-1, in the same VPC. Its security group must allow 5432 from the EC2 instance's security group only.
2. In `deploy/.env`, set `COMPOSE_PROFILES=` (empty), then set
   `DATABASE_URL=postgresql://USER:PASS@ENDPOINT:5432/centrix?sslmode=require`.
3. Move the data with `pg_dump` and `pg_restore` (section 5.1), then run `./deploy/scripts/deploy.sh`.

---

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| Screenshot upload returns 500, logs show `CredentialsProviderError` | IMDS hop limit is 1, or no instance role attached (section 3.2) |
| `AccessDenied` from S3 | `SCREENSHOT_S3_BUCKET` does not match the bucket the role policy names |
| Caddy logs `challenge failed` | DNS not yet pointing at the Elastic IP, or port 80 closed |
| Agents enroll but live commands never arrive | Agent installed with `-ServerUrl https://DOMAIN/api`. Reinstall with the bare domain |
| Agents get 404 on every call | Same cause: the agent requests `/api/api/v1/...` |
| Dashboard live view never connects | `DOMAIN` changed after the build. The dashboard image bakes the URL at build time, so rerun `deploy.sh` |
| Login succeeds then redirects back to login | Dashboard reached over plain HTTP; the session cookie is `Secure` in production |
| `migrate` exits non-zero and the API never starts | Read `docker compose ... logs migrate`. The previous API version keeps serving until this is fixed |
| Every agent rate-limited at once | `TRUST_PROXY` wrong for the topology; must be `1` behind Caddy alone |

See [troubleshooting.md](troubleshooting.md) for application-level symptoms.

---

## 9. Testing the production stack locally (Fedora)

[`deploy/docker-compose.local.yml`](../../deploy/docker-compose.local.yml) layers over the
production file. The images, Caddy routing, migrations and health checks are the same as in
production. Two things differ:

- **TLS.** `DOMAIN=localhost` makes Caddy use its own local certificate authority instead of Let's Encrypt.
- **S3.** Adobe S3Mock, an S3-compatible emulator, stands in for the bucket. Screenshot upload and viewing still run through the real S3 client code.

### 9.1 Install Docker Engine

Use Docker CE rather than Podman. The stack relies on Compose features such as optional
dependencies, profiles and completion conditions that `podman-compose` does not fully support.

```bash
sudo dnf -y remove podman-docker 2>/dev/null   # only if installed; it shadows the docker command
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager addrepo --from-repofile https://download.docker.com/linux/fedora/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # then log out and back in
docker compose version
```

### 9.2 Configure

```bash
cd deploy
cp .env.example .env
```

Set these values in `deploy/.env`. Everything else can stay as it is.

```dotenv
DOMAIN=localhost
ACME_EMAIL=test@example.org
SCREENSHOT_S3_BUCKET=centrix-local
POSTGRES_PASSWORD=<openssl rand -hex 32>
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DEVICE_TOKEN_PEPPER=<openssl rand -hex 32>
```

Ports 80 and 443 must be free on the machine. Stop any local web server first.

### 9.3 Run

```bash
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.local.yml up -d --build
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.local.yml ps
```

Do not use `deploy.sh` here. Its final check requires a publicly trusted certificate, which a
localhost certificate cannot be.

### 9.4 Verify

```bash
curl -k https://localhost/health        # API through Caddy, proves the database
curl -k https://localhost/api/health    # dashboard through Caddy
```

Then open `https://localhost` in a browser and accept the certificate warning once. Register an
organization at `https://localhost/ems/advanced/register-organization` and sign in.

To remove the browser warning, trust Caddy's local root certificate. Firefox keeps its own
certificate store, so it may still need a one-time exception.

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.local.yml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
sudo trust anchor --store ./caddy-local-root.crt
```

Windows agents cannot easily enroll against this setup, because they require a publicly trusted
certificate. Test agents against the real server.

### 9.5 Tear down

```bash
# Stop, keep data
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.local.yml down
# Stop and delete the database, screenshots and certificates
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.local.yml down -v
```

Before deploying to EC2, replace the local values in `.env`. The simplest way is to start again
from `.env.example` on the server.
