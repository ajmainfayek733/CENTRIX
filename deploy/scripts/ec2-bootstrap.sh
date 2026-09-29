#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 LTS EC2 instance to run the CENTRIX stack.
#
#   sudo ./ec2-bootstrap.sh
#
# Installs Docker Engine with the buildx and compose plugins from Docker's official apt
# repository, the AWS CLI v2 (for database backups), a swap file (so `next build` does not get
# OOM-killed on a 4 GiB host), and Docker daemon defaults for log rotation. Safe to re-run.
#
# Optional environment:
#   SWAP_SIZE_GB   default 2
#   DEPLOY_USER    user added to the docker group, default the invoking sudo user or ubuntu

set -euo pipefail

readonly DEFAULT_SWAP_SIZE_GB=2
readonly SWAP_FILE="/swapfile"
# Low swappiness: swap is an OOM safety net for image builds, not a place to page Postgres.
readonly SWAPPINESS=10
readonly DOCKER_LOG_MAX_SIZE="20m"
readonly DOCKER_LOG_MAX_FILES="5"
readonly DOCKER_KEYRING="/etc/apt/keyrings/docker.asc"
readonly DOCKER_REPO_URL="https://download.docker.com/linux/ubuntu"
readonly AWS_CLI_URL="https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip"

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || die "expected Ubuntu, found ${ID:-unknown}"

SWAP_SIZE_GB="${SWAP_SIZE_GB:-$DEFAULT_SWAP_SIZE_GB}"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
[[ "$SWAP_SIZE_GB" =~ ^[0-9]+$ ]] || die "SWAP_SIZE_GB must be a whole number"

export DEBIAN_FRONTEND=noninteractive

log "updating base packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg unzip git jq

# -- Docker Engine ------------------------------------------------------------
if ! command -v docker >/dev/null; then
  log "installing Docker Engine from ${DOCKER_REPO_URL}"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "${DOCKER_REPO_URL}/gpg" -o "$DOCKER_KEYRING"
  chmod a+r "$DOCKER_KEYRING"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=${DOCKER_KEYRING}] ${DOCKER_REPO_URL} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker already installed: $(docker --version)"
fi

log "configuring Docker daemon defaults"
install -m 0755 -d /etc/docker
cat > /etc/docker/daemon.json <<JSON
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "${DOCKER_LOG_MAX_SIZE}", "max-file": "${DOCKER_LOG_MAX_FILES}" },
  "live-restore": true
}
JSON
systemctl enable --now docker
systemctl restart docker

if id "$DEPLOY_USER" >/dev/null 2>&1; then
  usermod -aG docker "$DEPLOY_USER"
  log "added ${DEPLOY_USER} to the docker group (log out and back in to apply)"
fi

# -- AWS CLI v2 ---------------------------------------------------------------
if ! command -v aws >/dev/null; then
  log "installing AWS CLI v2"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "$AWS_CLI_URL" -o "$TMP_DIR/awscliv2.zip"
  unzip -q "$TMP_DIR/awscliv2.zip" -d "$TMP_DIR"
  "$TMP_DIR/aws/install"
else
  log "AWS CLI already installed: $(aws --version 2>&1)"
fi

# -- Swap ---------------------------------------------------------------------
if (( SWAP_SIZE_GB > 0 )) && ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  log "creating ${SWAP_SIZE_GB}G swap at ${SWAP_FILE}"
  fallocate -l "${SWAP_SIZE_GB}G" "$SWAP_FILE"
  chmod 600 "$SWAP_FILE"
  mkswap "$SWAP_FILE"
  swapon "$SWAP_FILE"
  grep -q "^${SWAP_FILE} " /etc/fstab || echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
fi
sysctl -w "vm.swappiness=${SWAPPINESS}" >/dev/null
echo "vm.swappiness=${SWAPPINESS}" > /etc/sysctl.d/99-centrix-swappiness.conf

# -- Unattended security updates ---------------------------------------------
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

log "done"
docker --version
docker compose version
docker buildx version
aws --version
