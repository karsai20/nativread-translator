#!/usr/bin/env bash
# ===========================================================================
# nativread-web — one-shot Proxmox installer (Next.js standalone on Node).
#
# Paste into the PROXMOX HOST shell (as root). Creates an unprivileged Debian LXC,
# installs Node, clones the app from GitHub, builds it, and runs the Next.js standalone
# server as a systemd service on an uncommon port. The household library + job state
# persist under /opt/nativread-web/data.
#
# The repo is PRIVATE — provide a GitHub token with `repo` scope via GH_TOKEN:
#
#   GH_TOKEN=ghp_xxx CTID=150 PORT=48217 TRANSLATION_PROVIDER=openai PROVIDER_API_KEY=sk-... PROVIDER_MODEL=... \
#     bash -c "$(curl -fsSL -H 'Authorization: token ghp_xxx' \
#       https://raw.githubusercontent.com/karsai20/nativread-translator/main/deploy/proxmox-install.sh)"
# ===========================================================================
set -euo pipefail

# ---- Tunables ----
GH_REPO="${GH_REPO:-karsai20/nativread-translator}"
BRANCH="${BRANCH:-main}"
GH_TOKEN="${GH_TOKEN:-}"

CTID="${CTID:-150}"
CT_HOSTNAME="${CT_HOSTNAME:-nativread-web}"
PORT="${PORT:-48217}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-2048}"
DISK_GB="${DISK_GB:-10}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
TEMPLATE="${TEMPLATE:-debian-12-standard_12.7-1_amd64.tar.zst}"
IPCONFIG="${IPCONFIG:-dhcp}"
GATEWAY="${GATEWAY:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"

PROVIDER_API_KEY="${PROVIDER_API_KEY:-}"
TRANSLATION_PROVIDER="${TRANSLATION_PROVIDER:-fake}"
PROVIDER_MODEL="${PROVIDER_MODEL:-}"
PROVIDER_BASE_URL="${PROVIDER_BASE_URL:-}"
PROVIDER_REASONER_MODEL="${PROVIDER_REASONER_MODEL:-}"
COST_CEILING_USD="${COST_CEILING_USD:-10}"
TRANSLATION_REFINE="${TRANSLATION_REFINE:-1}"
TRANSLATION_REFINE_SELECTIVE="${TRANSLATION_REFINE_SELECTIVE:-1}"
TRANSLATION_REASONER_HARD="${TRANSLATION_REASONER_HARD:-1}"
TRANSLATION_PRECISION="${TRANSLATION_PRECISION:-balanced}"
TRANSLATION_CONCURRENCY="${TRANSLATION_CONCURRENCY:-4}"
APP_DST="/opt/nativread-web"

log() { echo -e "\033[1;36m==>\033[0m $*"; }
[ -z "$GH_TOKEN" ] && echo "WARNING: GH_TOKEN empty; clone of the private repo will fail." >&2

# ---- Create the container if missing ----
if ! pct status "$CTID" >/dev/null 2>&1; then
  TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
    log "Downloading template $TEMPLATE"; pveam update || true; pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi
  if [ "$IPCONFIG" = "dhcp" ]; then NET="name=eth0,bridge=${BRIDGE},ip=dhcp"
  else NET="name=eth0,bridge=${BRIDGE},ip=${IPCONFIG}${GATEWAY:+,gw=$GATEWAY}"; fi
  log "Creating LXC $CTID ($CT_HOSTNAME)"
  pct create "$CTID" "$TEMPLATE_REF" \
    --hostname "$CT_HOSTNAME" --cores "$CORES" --memory "$MEMORY_MB" \
    --rootfs "${STORAGE}:${DISK_GB}" --net0 "$NET" \
    --features nesting=1 --unprivileged 1 --onboot 1
else
  log "CTID $CTID already exists; reusing it."
fi

pct start "$CTID" || true
log "Waiting for container network…"; sleep 6

# ---- Provision ----
CLONE_URL="https://github.com/${GH_REPO}.git"
AUTH_URL="$CLONE_URL"
[ -n "$GH_TOKEN" ] && AUTH_URL="https://x-access-token:${GH_TOKEN}@github.com/${GH_REPO}.git"

log "Installing Node ${NODE_MAJOR} + git in the container"
pct exec "$CTID" -- bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates >/dev/null
  if ! command -v node >/dev/null || [ \"\$(node -v | cut -dv -f2 | cut -d. -f1)\" -lt ${NODE_MAJOR} ]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
  node -v && npm -v
"

log "Cloning ${GH_REPO}@${BRANCH}"
pct exec "$CTID" -- bash -lc "
  set -e
  rm -rf '$APP_DST'
  git clone --branch '$BRANCH' --depth 1 '$AUTH_URL' '$APP_DST'
  git -C '$APP_DST' remote set-url origin '$CLONE_URL'   # scrub token
"

log "Writing .env (port $PORT, provider: $TRANSLATION_PROVIDER)"
pct exec "$CTID" -- bash -lc "cat > $APP_DST/.env <<EOF
TRANSLATION_PROVIDER=$TRANSLATION_PROVIDER
PROVIDER_API_KEY=$PROVIDER_API_KEY
PROVIDER_MODEL=$PROVIDER_MODEL
PROVIDER_BASE_URL=$PROVIDER_BASE_URL
PROVIDER_REASONER_MODEL=$PROVIDER_REASONER_MODEL
PORT=$PORT
HOSTNAME=0.0.0.0
JOBS_DIR=$APP_DST/data/jobs
LIBRARY_DIR=$APP_DST/data/library
COST_CEILING_USD=$COST_CEILING_USD
TRANSLATION_REFINE=$TRANSLATION_REFINE
TRANSLATION_REFINE_SELECTIVE=$TRANSLATION_REFINE_SELECTIVE
TRANSLATION_REASONER_HARD=$TRANSLATION_REASONER_HARD
TRANSLATION_PRECISION=$TRANSLATION_PRECISION
TRANSLATION_CONCURRENCY=$TRANSLATION_CONCURRENCY
EOF
mkdir -p $APP_DST/data/jobs $APP_DST/data/library"

log "Building (npm install + next build + standalone assets)"
pct exec "$CTID" -- bash -lc "
  set -e
  cd '$APP_DST'
  npm install --no-audit --no-fund
  npm run build
  cp -r .next/static .next/standalone/.next/static
  [ -d public ] && cp -r public .next/standalone/public || true
"

log "Installing + starting systemd service"
pct exec "$CTID" -- bash -lc "
  set -e
  cp $APP_DST/deploy/nativread-web.service /etc/systemd/system/nativread-web.service
  systemctl daemon-reload
  systemctl enable nativread-web
  systemctl restart nativread-web
  sleep 2
  systemctl --no-pager status nativread-web | head -n 10 || true
"

IP=$(pct exec "$CTID" -- bash -lc "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")
echo
log "Done. nativread-web is live at:  http://${IP}:${PORT}"
echo "    Logs:    pct exec $CTID -- journalctl -u nativread-web -f"
echo "    Update:  pct exec $CTID -- bash -lc 'cd $APP_DST && git pull && npm install && npm run build && cp -r .next/static .next/standalone/.next/static && systemctl restart nativread-web'"
