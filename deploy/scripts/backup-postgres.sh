#!/usr/bin/env bash
# Streams a compressed pg_dump of the bundled Postgres container to S3 or MinIO.
#
#   ./deploy/scripts/backup-postgres.sh
#
# Intended for cron on the EC2 host (see Docs/operations/aws-ec2-deployment.md). Nothing is
# written to local disk: the dump is piped straight to S3 using the instance role. Old backups
# are removed by the bucket lifecycle rule, not by this script, so a broken cron cannot delete
# the last good copy.
#
# With STORAGE_BACKEND=minio the dump goes to the MinIO bucket on this host through its loopback
# port, signed with the bucket-scoped service user. Expiry is a MinIO lifecycle rule created by
# the minio-init service. Note this copy shares the host's disk: pair it with provider snapshots
# or an off-host copy (see Docs/operations/hostinger-deployment.md).
#
# Not needed with RDS, which has its own automated backups.

set -euo pipefail

readonly DEFAULT_MINIO_API_PORT=9000

log() { printf '[backup] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

[[ -f "$ENV_FILE" ]] || die "missing ${ENV_FILE}"

# An absent key yields an empty string; see env_value in deploy.sh for why grep needs `|| true`.
env_value() {
  { grep -E "^$1=" "$ENV_FILE" || true; } | tail -n 1 | cut -d '=' -f 2- | sed -e 's/^"//' -e 's/"$//'
}

BACKUP_S3_URI="$(env_value BACKUP_S3_URI)"
AWS_REGION="$(env_value AWS_REGION)"
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
STORAGE_BACKEND="$(env_value STORAGE_BACKEND)"
[[ -n "$BACKUP_S3_URI" && "$BACKUP_S3_URI" == s3://* ]] || die "BACKUP_S3_URI must be an s3:// URI"
[[ -n "$AWS_REGION" ]] || die "AWS_REGION is empty"
[[ -n "$POSTGRES_USER" && -n "$POSTGRES_DB" ]] || die "POSTGRES_USER and POSTGRES_DB are required"

# Amazon S3 uses the instance role and SSE-S3. MinIO has no KMS configured, so it rejects any
# server-side-encryption header and needs explicit endpoint and credentials instead.
AWS_ARGS=(--region "$AWS_REGION" --only-show-errors)
if [[ "$STORAGE_BACKEND" == "minio" ]]; then
  MINIO_API_PORT="$(env_value MINIO_API_PORT)"
  MINIO_ENDPOINT="http://127.0.0.1:${MINIO_API_PORT:-$DEFAULT_MINIO_API_PORT}"
  AWS_ACCESS_KEY_ID="$(env_value MINIO_APP_ACCESS_KEY)"
  AWS_SECRET_ACCESS_KEY="$(env_value MINIO_APP_SECRET_KEY)"
  [[ -n "$AWS_ACCESS_KEY_ID" && -n "$AWS_SECRET_ACCESS_KEY" ]] \
    || die "MINIO_APP_ACCESS_KEY and MINIO_APP_SECRET_KEY are required when STORAGE_BACKEND=minio"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  AWS_ARGS+=(--endpoint-url "$MINIO_ENDPOINT")
else
  AWS_ARGS+=(--sse AES256)
fi

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_S3_URI%/}/${POSTGRES_DB}-${TIMESTAMP}.dump"

log "dumping ${POSTGRES_DB} to ${TARGET}"
# Custom format (-Fc) is already compressed and restores selectively with pg_restore.
# pipefail makes a pg_dump failure fail the whole pipeline instead of uploading a partial file.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner \
  | aws s3 cp - "$TARGET" "${AWS_ARGS[@]}"

log "complete"
