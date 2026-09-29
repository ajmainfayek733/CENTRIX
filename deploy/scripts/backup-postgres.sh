#!/usr/bin/env bash
# Streams a compressed pg_dump of the bundled Postgres container to S3.
#
#   ./deploy/scripts/backup-postgres.sh
#
# Intended for cron on the EC2 host (see Docs/operations/aws-ec2-deployment.md). Nothing is
# written to local disk: the dump is piped straight to S3 using the instance role. Old backups
# are removed by the bucket lifecycle rule, not by this script, so a broken cron cannot delete
# the last good copy.
#
# Not needed with RDS, which has its own automated backups.

set -euo pipefail

log() { printf '[backup] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

[[ -f "$ENV_FILE" ]] || die "missing ${ENV_FILE}"

env_value() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- | sed -e 's/^"//' -e 's/"$//'
}

BACKUP_S3_URI="$(env_value BACKUP_S3_URI)"
AWS_REGION="$(env_value AWS_REGION)"
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
[[ -n "$BACKUP_S3_URI" && "$BACKUP_S3_URI" == s3://* ]] || die "BACKUP_S3_URI must be an s3:// URI"
[[ -n "$AWS_REGION" ]] || die "AWS_REGION is empty"
[[ -n "$POSTGRES_USER" && -n "$POSTGRES_DB" ]] || die "POSTGRES_USER and POSTGRES_DB are required"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_S3_URI%/}/${POSTGRES_DB}-${TIMESTAMP}.dump"

log "dumping ${POSTGRES_DB} to ${TARGET}"
# Custom format (-Fc) is already compressed and restores selectively with pg_restore.
# pipefail makes a pg_dump failure fail the whole pipeline instead of uploading a partial file.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner \
  | aws s3 cp - "$TARGET" --region "$AWS_REGION" --sse AES256 --only-show-errors

log "complete"
