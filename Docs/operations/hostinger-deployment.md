# Hostinger VPS deployment (Docker + Caddy + MinIO)

Production runbook for the dashboard and API on a single Hostinger KVM VPS (Ubuntu LTS, x86_64),
with screenshots and database backups in a self-hosted MinIO bucket. Every file referenced here
lives in [`deploy/`](../../deploy/). The AWS variant is in [aws-ec2-deployment.md](aws-ec2-deployment.md);
both share the same compose file, Caddyfile and `deploy.sh`.

---

## 1. Architecture

```text
                 Hostinger KVM 4 (4 vCPU, 16 GiB, public IPv4)
              +-------------------------------------------------------------+
 Browser  --> | caddy (https://DOMAIN, Let's Encrypt)                       |
 Agents   --> |   /api/v1/*  /socket.io/*  /health  --> api:5000           |
              |   everything else                    --> frontend:3000      |
              |                                                             |
              |   api --> postgres:5432  (container, named volume)          |
              |   api --> minio:9000     (container, named volume)          |
              |   127.0.0.1:9000 S3 API, 127.0.0.1:9001 console (loopback)  |
              +-------------------------------------------------------------+
```

URL routing on the single domain is identical to the AWS deployment; see section 1 of
[aws-ec2-deployment.md](aws-ec2-deployment.md). **Agents are installed with
`-ServerUrl https://DOMAIN`, not `https://DOMAIN/api`.**

| Decision | Reason |
|---|---|
| MinIO reached only over the private compose network | The API streams screenshots to the dashboard itself, so browsers never talk to storage. No public S3 endpoint, no extra certificate |
| API uses a bucket-scoped MinIO user | A leaked API credential cannot administer MinIO or touch other buckets. `minio-init` creates the user and policy on every deploy |
| MinIO ports bound to `127.0.0.1` | Docker-published ports bypass `ufw`. Loopback keeps the console and S3 API off the internet |
| MinIO image from the `pgsty` fork | MinIO stopped publishing community Docker images in October 2025. Override with `MINIO_IMAGE` and `MINIO_MC_IMAGE` to use your own build |

---

## 2. Prerequisites

1. **DNS.** The `A` record for the domain must equal the VPS IPv4. If an `AAAA` record exists it
   must equal the VPS IPv6, or be deleted: Let's Encrypt prefers IPv6, so a stale `AAAA` fails
   certificate issuance even when the `A` record is right.
   ```bash
   dig +short A DOMAIN && dig +short AAAA DOMAIN
   ```
2. **Hostinger firewall** (hPanel, VPS, Security): allow TCP 22, TCP 80, TCP 443 and UDP 443.
3. **SSH key login** for the deploy user. Do not keep password login for `root` on an
   internet-facing host.

---

## 3. First deployment

```bash
ssh root@VPS_IP
apt-get update && apt-get install -y git
git clone <repository-url> /opt/centrix && cd /opt/centrix
ENABLE_UFW=true ./deploy/scripts/host-bootstrap.sh     # Docker, swap, ufw, unattended upgrades
```

```bash
cd /opt/centrix/deploy
cp .env.hostinger.example .env && chmod 600 .env
openssl rand -hex 32    # run five times: POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD,
                        # MINIO_APP_SECRET_KEY, BETTER_AUTH_SECRET, DEVICE_TOKEN_PEPPER
nano .env               # DOMAIN, ACME_EMAIL, and every empty secret
./scripts/deploy.sh
```

`deploy.sh` validates `.env` (placeholders, short secrets, root and service user collisions),
builds the images, and starts the stack in dependency order:
`postgres` and `minio` healthy, then `migrate` and `minio-init` exit 0, then `api`, `frontend`,
`caddy`. It finishes by probing `https://DOMAIN/health` (API plus database) and
`https://DOMAIN/api/health` (dashboard).

> **Back up `DEVICE_TOKEN_PEPPER` and `MINIO_ROOT_PASSWORD` outside the host** in a password
> manager. Losing the pepper forces every agent to re-enroll.

Then create the organization at `https://DOMAIN/ems/advanced/register-organization` and install
agents as in [aws-ec2-deployment.md](aws-ec2-deployment.md) section 4.1.

### 3.1 Verify storage end to end

```bash
cd /opt/centrix/deploy
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.minio.yml ps
docker compose --env-file .env -f docker-compose.prod.yml -f docker-compose.minio.yml logs minio-init
```

After an agent uploads its first screenshot it must open in the dashboard. List the bucket with
the service user:

```bash
AWS_ACCESS_KEY_ID=centrixapp AWS_SECRET_ACCESS_KEY=<MINIO_APP_SECRET_KEY> \
  aws --endpoint-url http://127.0.0.1:9000 s3 ls s3://centrix-screenshots/ --recursive | head
```

---

## 4. Day-2 operations

Set a shell alias once so every command below includes the MinIO override:

```bash
alias cx='docker compose --env-file /opt/centrix/deploy/.env -f /opt/centrix/deploy/docker-compose.prod.yml -f /opt/centrix/deploy/docker-compose.minio.yml'
```

| Task | Command |
|---|---|
| Deploy a new version | `cd /opt/centrix && git pull && ./deploy/scripts/deploy.sh` |
| Roll back | `IMAGE_TAG=<previous short sha> cx up -d` |
| Logs | `cx logs -f --tail=200 api` |
| Restart one service | `cx restart api` |
| Database shell | `cx exec postgres psql -U centrix centrix` |
| MinIO console | `ssh -L 9001:127.0.0.1:9001 root@VPS_IP`, then open `http://127.0.0.1:9001` and sign in as `MINIO_ROOT_USER` |

Rolling back past a migration requires restoring a database backup, because Prisma migrations
only move forward.

### 4.1 Backups

Nightly `pg_dump` into the MinIO bucket under `backups/postgres`, expiring after
`BACKUP_RETENTION_DAYS` through a lifecycle rule that `minio-init` maintains:

```bash
crontab -e   # the AWS CLI it uses is installed by host-bootstrap.sh
0 21 * * * /opt/centrix/deploy/scripts/backup-postgres.sh >> /var/log/centrix-backup.log 2>&1
```

Restore into the running container:

```bash
AWS_ACCESS_KEY_ID=centrixapp AWS_SECRET_ACCESS_KEY=<MINIO_APP_SECRET_KEY> \
  aws --endpoint-url http://127.0.0.1:9000 s3 cp \
  s3://centrix-screenshots/backups/postgres/centrix-YYYYMMDDTHHMMSSZ.dump - \
  | cx exec -T postgres pg_restore -U centrix -d centrix --clean --if-exists --no-owner
```

**These dumps live on the same disk as the database.** They protect against corruption and
mistakes, not against losing the VPS. Enable Hostinger's automatic backups or weekly snapshots
(hPanel, VPS, Backups), and copy the newest dump off-host periodically. Screenshots in the
`minio-data` volume are covered by the same snapshots.

---

## 5. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Caddy logs `challenge failed` or never gets a certificate | DNS does not point at this VPS, including a stale `AAAA` record, or a firewall blocks 80. See section 2 |
| `minio-init` fails at `mc alias set` | MinIO is not healthy yet or the root credentials in `.env` changed after first start. Existing data keeps the old root password until the volume is reset |
| Screenshot upload returns 5xx, API logs `AccessDenied` | The service user policy is missing. Re-run `deploy.sh`, which recreates it |
| `deploy.sh` says `MINIO_APP_ACCESS_KEY must differ from MINIO_ROOT_USER` | Use separate names for the root and service accounts |
