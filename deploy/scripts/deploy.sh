#!/usr/bin/env bash
# Builds and (re)starts the CENTRIX production stack on this host.
#
#   ./deploy/scripts/deploy.sh            # build from the current checkout and roll forward
#   ./deploy/scripts/deploy.sh --no-build # restart with the images already on this host
#
# STORAGE_BACKEND in deploy/.env selects where screenshots live: "s3" (default, Amazon S3 through
# the EC2 instance role) or "minio" (self-hosted MinIO via docker-compose.minio.yml).
#
# Validates deploy/.env before touching anything, tags images with the git commit so a rollback
# is `IMAGE_TAG=<old sha> docker compose ... up -d`, waits for every service to report healthy,
# and prunes dangling images so repeated deploys do not fill the root volume.

set -euo pipefail

readonly HEALTH_WAIT_SECONDS=300
readonly HEALTH_POLL_SECONDS=5
# Hex secrets from `openssl rand -hex 32` are 64 characters; the API itself requires 16+.
readonly MIN_SECRET_LENGTH=32
readonly PLACEHOLDER_PATTERN='example\.com|CHANGE-ME'
readonly STORAGE_S3="s3"
readonly STORAGE_MINIO="minio"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"
MINIO_COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.minio.yml"

BUILD=true
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=false ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[[ -f "$ENV_FILE" ]] || die "missing ${ENV_FILE} - copy deploy/.env.example and fill it in"

# Reads KEY from the env file without sourcing it, so values are never executed as shell.
env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d '=' -f 2- | sed -e 's/^"//' -e 's/"$//'
}

require() {
  local key="$1" value
  value="$(env_value "$key")"
  [[ -n "$value" ]] || die "${key} is empty in ${ENV_FILE}"
  if [[ "$value" =~ $PLACEHOLDER_PATTERN ]]; then
    die "${key} still holds a placeholder value (${value})"
  fi
}

require_secret() {
  local key="$1" value
  require "$key"
  value="$(env_value "$key")"
  (( ${#value} >= MIN_SECRET_LENGTH )) || die "${key} must be at least ${MIN_SECRET_LENGTH} characters"
}

log "validating ${ENV_FILE}"
for key in DOMAIN ACME_EMAIL AWS_REGION SCREENSHOT_S3_BUCKET; do
  require "$key"
done
DOMAIN="$(env_value DOMAIN)"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "DOMAIN must be a bare hostname (no https:// and no path): ${DOMAIN}"
require_secret BETTER_AUTH_SECRET
require_secret DEVICE_TOKEN_PEPPER

STORAGE_BACKEND="$(env_value STORAGE_BACKEND)"
STORAGE_BACKEND="${STORAGE_BACKEND:-$STORAGE_S3}"
case "$STORAGE_BACKEND" in
  "$STORAGE_S3") ;;
  "$STORAGE_MINIO")
    for key in MINIO_ROOT_USER MINIO_APP_ACCESS_KEY; do
      require "$key"
      [[ "$(env_value "$key")" =~ ^[A-Za-z0-9]{3,}$ ]] || die "${key} must be alphanumeric, 3+ characters"
    done
    [[ "$(env_value MINIO_ROOT_USER)" != "$(env_value MINIO_APP_ACCESS_KEY)" ]] \
      || die "MINIO_APP_ACCESS_KEY must differ from MINIO_ROOT_USER"
    require_secret MINIO_ROOT_PASSWORD
    require_secret MINIO_APP_SECRET_KEY
    ;;
  *) die "STORAGE_BACKEND must be '${STORAGE_S3}' or '${STORAGE_MINIO}': ${STORAGE_BACKEND}" ;;
esac

if [[ ",$(env_value COMPOSE_PROFILES)," == *",bundled-db,"* ]]; then
  require_secret POSTGRES_PASSWORD
  [[ "$(env_value POSTGRES_PASSWORD)" =~ ^[A-Za-z0-9]+$ ]] \
    || die "POSTGRES_PASSWORD must be alphanumeric so it is valid inside DATABASE_URL"
else
  require DATABASE_URL
fi

if [[ "$(stat -c '%a' "$ENV_FILE")" != "600" ]]; then
  log "tightening ${ENV_FILE} permissions to 600"
  chmod 600 "$ENV_FILE"
fi

command -v docker >/dev/null || die "docker not found - run deploy/scripts/host-bootstrap.sh first"
docker compose version >/dev/null || die "docker compose plugin not found"

IMAGE_TAG="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)"
export IMAGE_TAG
log "image tag ${IMAGE_TAG}"

COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
DIAGNOSTIC_SERVICES=(migrate api frontend caddy)
if [[ "$STORAGE_BACKEND" == "$STORAGE_MINIO" ]]; then
  COMPOSE_ARGS+=(-f "$MINIO_COMPOSE_FILE")
  DIAGNOSTIC_SERVICES+=(minio minio-init)
fi
log "storage backend ${STORAGE_BACKEND}"

compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

compose config --quiet || die "compose configuration is invalid"

if [[ "$BUILD" == true ]]; then
  log "building images"
  compose build --pull
fi

# `up -d` blocks on the depends_on conditions: migrate must exit 0, then api and frontend must
# report healthy, before caddy starts. A failed migration or an unhealthy service fails here.
# (`--wait` is avoided: some compose releases treat the one-shot migrate exiting as a failure.)
log "starting stack (migrations run before the API starts)"
compose up -d --remove-orphans \
  || { compose ps -a; compose logs --tail=100 "${DIAGNOSTIC_SERVICES[@]}"; die "stack did not become healthy"; }

# Two probes on one domain exercise both sides of the Caddy path split: /health must reach the
# API (and prove the database), /api/health must reach the dashboard.
log "verifying public endpoints"
deadline=$(( SECONDS + HEALTH_WAIT_SECONDS ))
until curl -fsS "https://${DOMAIN}/health" >/dev/null 2>&1 \
  && curl -fsS "https://${DOMAIN}/api/health" >/dev/null 2>&1; do
  (( SECONDS < deadline )) || { compose logs --tail=50 caddy; die "public HTTPS checks failed (DNS or certificate issue?)"; }
  sleep "$HEALTH_POLL_SECONDS"
done

log "pruning dangling images"
docker image prune -f >/dev/null

compose ps
log "deployed ${IMAGE_TAG}: dashboard https://${DOMAIN}, agent ServerUrl https://${DOMAIN}"
