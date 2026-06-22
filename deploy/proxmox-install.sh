#!/usr/bin/env bash
# ===========================================================================
# quire-translator — one-shot Proxmox installer.
#
# Paste this whole thing into the PROXMOX HOST shell (as root). It creates an
# unprivileged Debian LXC, installs Bun, clones the app from GitHub, builds it,
# and runs it as a systemd service on an uncommon port.
#
# The repo is PRIVATE, so provide a GitHub token with `repo` scope:
#
#   GH_TOKEN=ghp_xxx bash -c "$(curl -fsSL \
#     -H 'Authorization: token ghp_xxx' \
#     https://raw.githubusercontent.com/karsai20/quire-translator/main/deploy/proxmox-install.sh)"
#
# ...or simply: set GH_TOKEN, paste the script body, run.
#
# Common overrides (all optional):
#   CTID=150 PORT=48217 PROVIDER_API_KEY=sk-... GH_TOKEN=ghp_xxx ./proxmox-install.sh
# ===========================================================================
set -euo pipefail

# ---- Tunables ----
GH_REPO="${GH_REPO:-karsai20/quire-translator}"
BRANCH="${BRANCH:-main}"
GH_TOKEN="${GH_TOKEN:-}"               # needed for the private repo

CTID="${CTID:-150}"
CT_HOSTNAME="${CT_HOSTNAME:-quire-translator}"
PORT="${PORT:-48217}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-2048}"
DISK_GB="${DISK_GB:-8}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
TEMPLATE="${TEMPLATE:-debian-12-standard_12.7-1_amd64.tar.zst}"
IPCONFIG="${IPCONFIG:-dhcp}"           # "dhcp" or e.g. "192.168.1.50/24"
GATEWAY="${GATEWAY:-}"                 # set for static IP

PROVIDER_API_KEY="${PROVIDER_API_KEY:-}"
COST_CEILING_USD="${COST_CEILING_USD:-10}"
APP_DST="/opt/quire-translator"

log() { echo -e "\033[1;36m==>\033[0m $*"; }

if [ -z "$GH_TOKEN" ]; then
  echo "WARNING: GH_TOKEN is empty. The repo is private; the clone will fail without it." >&2
fi

# ---- Create the container if missing ----
if ! pct status "$CTID" >/dev/null 2>&1; then
  TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
    log "Downloading template $TEMPLATE"
    pveam update || true
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi

  if [ "$IPCONFIG" = "dhcp" ]; then
    NET="name=eth0,bridge=${BRIDGE},ip=dhcp"
  else
    NET="name=eth0,bridge=${BRIDGE},ip=${IPCONFIG}${GATEWAY:+,gw=$GATEWAY}"
  fi

  log "Creating LXC $CTID ($CT_HOSTNAME)"
  pct create "$CTID" "$TEMPLATE_REF" \
    --hostname "$CT_HOSTNAME" \
    --cores "$CORES" \
    --memory "$MEMORY_MB" \
    --rootfs "${STORAGE}:${DISK_GB}" \
    --net0 "$NET" \
    --features nesting=1 \
    --unprivileged 1 \
    --onboot 1
else
  log "CTID $CTID already exists; reusing it."
fi

pct start "$CTID" || true
log "Waiting for container network…"
sleep 6

# ---- Provision inside the container ----
CLONE_URL="https://github.com/${GH_REPO}.git"
AUTH_URL="$CLONE_URL"
[ -n "$GH_TOKEN" ] && AUTH_URL="https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git"

log "Installing packages + Bun in the container"
pct exec "$CTID" -- bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git unzip ca-certificates >/dev/null
  if [ ! -x /root/.bun/bin/bun ]; then curl -fsSL https://bun.sh/install | bash; fi
  /root/.bun/bin/bun --version
'

log "Cloning ${GH_REPO}@${BRANCH}"
pct exec "$CTID" -- bash -lc "
  set -e
  rm -rf '$APP_DST'
  git clone --branch '$BRANCH' --depth 1 '$AUTH_URL' '$APP_DST'
  # Scrub the token from the saved remote.
  git -C '$APP_DST' remote set-url origin '$CLONE_URL'
"

log "Writing .env (port $PORT, provider: $([ -n "$PROVIDER_API_KEY" ] && echo deepseek || echo fake))"
pct exec "$CTID" -- bash -lc "cat > $APP_DST/.env <<EOF
PROVIDER_API_KEY=$PROVIDER_API_KEY
HOST=0.0.0.0
PORT=$PORT
JOBS_DIR=$APP_DST/jobs
COST_CEILING_USD=$COST_CEILING_USD
EOF"

log "Installing deps + building web bundle"
pct exec "$CTID" -- bash -lc "cd $APP_DST && /root/.bun/bin/bun install && /root/.bun/bin/bun run build:web"

log "Installing + starting systemd service"
pct exec "$CTID" -- bash -lc "
  set -e
  cp $APP_DST/deploy/quire-translator.service /etc/systemd/system/quire-translator.service
  systemctl daemon-reload
  systemctl enable quire-translator
  systemctl restart quire-translator
  sleep 2
  systemctl --no-pager status quire-translator | head -n 10 || true
"

IP=$(pct exec "$CTID" -- bash -lc "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")
echo
log "Done. quire-translator is live at:  http://${IP}:${PORT}"
echo "    Logs:    pct exec $CTID -- journalctl -u quire-translator -f"
echo "    Update:  pct exec $CTID -- bash -lc 'cd $APP_DST && git pull && /root/.bun/bin/bun install && bun run build:web && systemctl restart quire-translator'"
