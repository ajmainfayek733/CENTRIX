# AWS deployment (EC2 + S3)

Production runbook for the dashboard and API on a single EC2 host, with screenshots in S3.
Every file referenced here lives in [`deploy/`](../../deploy/).

---

## 1. Architecture

```
                      EC2 (Ubuntu 24.04, t3.medium, Elastic IP)
                   +----------------------------------------------------+
 Browser ---443--> | caddy --> frontend:3000   (APP_DOMAIN, dashboard)  |
 Agents  ---443--> |       --> api:5000        (API_DOMAIN, REST + WS)  |
                   |            |                                       |
                   |            +--> postgres:5432 (container, EBS)     |
                   +------------|---------------------------------------+
                                +--> S3 bucket (screenshots, DB backups)
                                     via instance role, no access keys
```

| Decision | Reason |
|---|---|
| Two hostnames | The Next.js dashboard owns `/api/*` for its route handlers, so the Express API cannot share its path space |
| Caddy for TLS | Issues and renews Let's Encrypt certificates automatically; proxies WebSockets without extra config |
| Dashboard calls the API on the private network | `MONITORING_API_URL=http://api:5000`; no TLS hairpin, and the API port is never published |
| Instance role for S3 | No long-lived keys on disk. Requires IMDS hop limit 2 (section 3) |
| Postgres in a container by default | Cheapest option. Switch to RDS by changing two values (section 7) |
| Migrations as a one-shot service | Run before the API starts; a failed migration keeps the old API from starting on a new schema |

---

## 2. Prerequisites

- An AWS account and the AWS CLI v2 on your workstation, or AWS CloudShell.
- A domain whose DNS you control.
- Two hostnames chosen, for example `app.acme.com` and `api.acme.com`.

---

## 3. Provision AWS resources

### 3.1 EC2 instance

| Setting | Value |
|---|---|
| AMI | Ubuntu Server 24.04 LTS (x86_64) |
| Type | `t3.medium` (2 vCPU, 4 GiB) |
| Root volume | 30 GiB gp3, encrypted |
| Security group inbound | TCP 80 and TCP 443 from `0.0.0.0/0`, UDP 443 from `0.0.0.0/0` (HTTP/3) |
| SSH | Not needed. Use SSM Session Manager (the role grants it). If you do open 22, restrict it to your office IP |
| Elastic IP | Allocate and associate one, so the address survives stop/start |

### 3.2 S3 bucket and instance role

From your workstation, with the instance ID from step 3.1:

```bash
AWS_REGION=us-east-1 \
BUCKET=centrix-screenshots-acme \
INSTANCE_ID=i-0123456789abcdef0 \
  ./deploy/aws/setup-s3-and-iam.sh
```

It is idempotent and does the following:

- **Creates the bucket.** Public access is blocked, ACLs are disabled, SSE-S3 encryption is on, and non-TLS requests are denied.
- **Adds lifecycle rules.** Screenshots move to Standard-IA after 30 days. Database backups expire after 14 days. Incomplete uploads are aborted.
- **Creates the `centrix-ec2-role` role.** It can put and get objects in this bucket only, and it grants SSM Session Manager.
- **Attaches the role to the instance.** It also sets IMDSv2 to required with hop limit 2.

> **Hop limit 2 is not optional.** Containers are one network hop behind the host. At the
> default of 1, the AWS SDK inside the API container gets no credentials and every screenshot
> upload fails with `CredentialsProviderError`.

### 3.3 DNS

Create two A records pointing at the Elastic IP: `APP_DOMAIN` and `API_DOMAIN`. Wait until
`dig +short api.acme.com` returns the Elastic IP before the first start, or certificate issuance
fails and Caddy retries with backoff.

---

## 4. First deployment

Connect with Session Manager (`aws ssm start-session --target i-...`) or SSH, then:

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
nano .env              # fill every REQUIRED value
./scripts/deploy.sh
```

`deploy.sh` refuses to start on empty or short secrets, placeholder domains, or an empty bucket name. It then
builds both images, runs migrations, waits for health, and checks both public HTTPS URLs.

> **Back up `DEVICE_TOKEN_PEPPER` outside the host** (a password manager). Losing it invalidates
> every enrolled agent's key and forces the whole fleet to re-enroll.

### 4.1 Create the organization and point agents at the API

1. Open `https://APP_DOMAIN/ems/advanced/register-organization`, then store the enrollment token it shows once.
2. Install agents with `-ServerUrl https://API_DOMAIN`. Continue with
   [backend-deployment.md](backend-deployment.md) section 1.

### 4.2 Verify

```bash
curl -fsS https://api.acme.com/health        # {"status":"ok",...} proves API + database
curl -fsS https://app.acme.com/api/health    # dashboard process
docker compose -f deploy/docker-compose.prod.yml ps
```

Then confirm S3 end to end: after an agent uploads its first screenshot, it must open in the
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
# 02:30 UTC daily
30 2 * * * /home/ubuntu/centrix/deploy/scripts/backup-postgres.sh >> /home/ubuntu/backup.log 2>&1
```

Restore into the running container:

```bash
aws s3 cp s3://BUCKET/backups/postgres/centrix-YYYYMMDDTHHMMSSZ.dump - \
  | docker compose -f deploy/docker-compose.prod.yml exec -T postgres \
      pg_restore -U centrix -d centrix --clean --if-exists --no-owner
```

**EBS snapshots.** Create an Amazon Data Lifecycle Manager policy for the instance's volume,
daily with 7 retained. This covers the Caddy certificates and anything else on disk.

Screenshots need no backup job. S3 stores each object redundantly across availability zones.

---

## 6. Monthly cost estimate

On-demand list prices, **us-east-1**, excluding tax and domain registration. Mumbai
(ap-south-1) and Singapore (ap-southeast-1) run roughly 5 to 15 percent higher. Confirm with the
[AWS Pricing Calculator](https://calculator.aws/) for your region.

### Assumptions

| Input | Value | Source |
|---|---|---|
| Employees / agents | 100 | Upper end of the sizing the defaults target |
| Screenshot interval | 10 minutes | Policy default `screenshotIntervalSeconds = 600` |
| Screenshot size | ~200 KB | JPEG quality 70 at 1080p |
| Working time | 8 h/day, 22 days/month | |
| Screenshots per month | ~105,600 (~21 GB) | 100 x 48 per day x 22 |

### Recommended setup: everything on one t3.medium

| Item | Calculation | Month 1 | Month 12 |
|---|---|---|---|
| EC2 t3.medium | $0.0416/h x 730 h | $30.37 | $30.37 |
| EBS gp3 root, 30 GB | $0.08/GB | $2.40 | $2.40 |
| Public IPv4 (Elastic IP) | $0.005/h x 730 h | $3.65 | $3.65 |
| EBS snapshots (DLM, 7 daily) | ~10 GB changed data x $0.05 | $0.50 | $0.50 |
| S3 storage, screenshots | 21 GB Standard; by month 12, 21 GB Standard + 232 GB Standard-IA | $0.48 | $3.38 |
| S3 PUT requests | 105,600 x $0.005 per 1,000 | $0.53 | $0.53 |
| S3 lifecycle transitions to IA | 105,600 x $0.01 per 1,000 | $0.00 | $1.06 |
| S3 database backups | 14 dumps, under 1 GB each | $0.30 | $0.30 |
| Data transfer out | Dashboard traffic stays inside the 100 GB/month free allowance | $0.00 | $0.00 |
| Route 53 hosted zone (if used) | | $0.50 | $0.50 |
| **Total** | | **~$39** | **~$43** |

With a 1-year Compute Savings Plan or Reserved Instance, t3.medium drops to about $0.026/h
($18.98/month), bringing the total to **about $28 to $32**.

At 50 employees, the S3 lines halve. The total barely changes, because the instance is most of
the bill.

### Alternative: managed database (Amazon RDS)

| Item | Month 1 |
|---|---|
| EC2 t3.small (2 GiB; Postgres moved off the host) | $15.18 |
| RDS db.t4g.micro, single-AZ, 20 GB gp3, 7-day automated backups | ~$14.00 |
| EBS 20 GB + Elastic IP + S3 + Route 53 | ~$7.00 |
| **Total** | **~$36** |

This costs about the same and buys automated point-in-time recovery and managed patching. A
Multi-AZ RDS instance roughly doubles the RDS line. A t3.small builds the dashboard image slowly
and relies on swap during `next build`.

### What moves the bill

- **Screenshot interval.** Halving the interval doubles S3 growth. That still costs cents per month at this scale.
- **Instance size.** Instance size is roughly 75 percent of the total. Watch memory before resizing: `docker stats`.
- **Data transfer.** Past 100 GB/month out, AWS charges $0.09/GB. Only heavy screenshot browsing from outside AWS gets there.

---

## 7. Switching to RDS

1. Create a PostgreSQL 17 RDS instance in the same VPC. Its security group must allow 5432 from the EC2 instance's security group only.
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
| Dashboard live view never connects | Browser cannot reach `https://API_DOMAIN`. The dashboard image bakes this URL at build time, so rebuild after changing `API_DOMAIN` |
| Login succeeds then redirects back to login | Dashboard reached over plain HTTP; the session cookie is `Secure` in production |
| `migrate` exits non-zero and the API never starts | Read `docker compose ... logs migrate`. The previous API version keeps serving until this is fixed |
| Every agent rate-limited at once | `TRUST_PROXY` wrong for the topology; must be `1` behind Caddy alone |

See [troubleshooting.md](troubleshooting.md) for application-level symptoms.
