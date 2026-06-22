#!/usr/bin/env bash
# Provision quire-translator inside its own Debian LXC on a Proxmox host.
#
# Run this ON THE PROXMOX HOST (PVE shell), as root. It creates an unprivileged LXC,
# installs Bun, copies the app, writes .env, and enables a systemd service bound to an
# uncommon port. Re-running is safe-ish: it skips container creation if CTID exists.
#
# Usage:
#   ./proxmox-lxc-setup.sh            # uses the defaults below
#   CTID=151 PORT=48217 ./proxmox-lxc-setup.sh
#
# Then browse to http://<container-ip>:<PORT> from the LAN.

set -euo pipefail

# ---- Tunables (override via env) ----
CTID="${CTID:-150}"
HOSTNAME="${HOSTNAME:-quire-translator}"
PORT="${PORT:-48217}"
CORES="${CORES:-2}"
MEMORY_MB="${MEMORY_MB:-2048}"
DISK_GB="${DISK_GB:-8}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-local-lvm}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
TEMPLATE="${TEMPLATE:-debian-12-standard_12.7-1_amd64.tar.zst}"
# IP: "dhcp" or a CIDR like "192.168.1.50/24" (set GATEWAY too if static).
IPCONFIG="${IPCONFIG:-dhcp}"
GATEWAY="${GATEWAY:-}"
# Source of the app on the Proxmox host (this repo). Defaults to the script's repo root.
APP_SRC="${APP_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"
# Optional: bake in the DeepSeek key. Leave empty to run the fake provider.
PROVIDER_API_KEY="${PROVIDER_API_KEY:-}"
COST_CEILING_USD="${COST_CEILING_USD:-10}"

APP_DST="/opt/quire-translator"

echo "==> quire-translator LXC provision"
echo "    CTID=$CTID hostname=$HOSTNAME port=$PORT bridge=$BRIDGE storage=$STORAGE"

# ---- Create the container if it does not exist ----
if ! pct status "$CTID" >/dev/null 2>&1; then
  TEMPLATE_REF="${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}"
  if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
    echo "==> Downloading template $TEMPLATE"
    pveam update || true
    pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
  fi

  if [ "$IPCONFIG" = "dhcp" ]; then
    NET="name=eth0,bridge=${BRIDGE},ip=dhcp"
  else
    NET="name=eth0,bridge=${BRIDGE},ip=${IPCONFIG}${GATEWAY:+,gw=$GATEWAY}"
  fi

  echo "==> Creating LXC $CTID"
  pct create "$CTID" "$TEMPLATE_REF" \
    --hostname "$HOSTNAME" \
    --cores "$CORES" \
    --memory "$MEMORY_MB" \
    --rootfs "${STORAGE}:${DISK_GB}" \
    --net0 "$NET" \
    --features nesting=1 \
    --unprivileged 1 \
    --onboot 1
else
  echo "==> CTID $CTID already exists; skipping create."
fi

pct start "$CTID" || true
sleep 5

echo "==> Installing base packages + Bun inside the container"
pct exec "$CTID" -- bash -lc '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl unzip ca-certificates >/dev/null
  if [ ! -x /root/.bun/bin/bun ]; then
    curl -fsSL https://bun.sh/install | bash
  fi
  /root/.bun/bin/bun --version
'

echo "==> Copying app from $APP_SRC -> $CTID:$APP_DST"
pct exec "$CTID" -- mkdir -p "$APP_DST"
# Push source (exclude local/build artifacts).
tar --exclude=node_modules --exclude=jobs --exclude=.git --exclude='src/web/dist' \
    --exclude='*.log' -C "$APP_SRC" -czf - . | pct exec "$CTID" -- tar -xzf - -C "$APP_DST"

echo "==> Writing .env"
pct exec "$CTID" -- bash -lc "cat > $APP_DST/.env <<EOF
PROVIDER_API_KEY=$PROVIDER_API_KEY
HOST=0.0.0.0
PORT=$PORT
JOBS_DIR=$APP_DST/jobs
COST_CEILING_USD=$COST_CEILING_USD
EOF"

echo "==> Installing deps + building web bundle"
pct exec "$CTID" -- bash -lc "cd $APP_DST && /root/.bun/bin/bun install && /root/.bun/bin/bun run build:web"

echo "==> Installing systemd service"
pct push "$CTID" "$APP_SRC/deploy/quire-translator.service" /etc/systemd/system/quire-translator.service
# Make the unit's port match (the unit reads PORT from .env, but keep them aligned).
pct exec "$CTID" -- bash -lc '
  systemctl daemon-reload
  systemctl enable quire-translator
  systemctl restart quire-translator
  sleep 2
  systemctl --no-pager status quire-translator | head -n 12 || true
'

IP=$(pct exec "$CTID" -- bash -lc "hostname -I | awk '{print \$1}'" 2>/dev/null || echo "<container-ip>")
echo
echo "==> Done. quire-translator should be live at: http://${IP}:${PORT}"
echo "    Logs:   pct exec $CTID -- journalctl -u quire-translator -f"
echo "    Update: re-run this script (it re-pushes source + restarts)."
