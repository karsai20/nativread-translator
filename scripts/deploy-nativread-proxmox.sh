#!/usr/bin/env bash
set -euo pipefail

# Deploy the current local checkout to a Proxmox host over SSH, without requiring the
# GitHub repo to exist or be reachable from the Proxmox server.
#
# Required:
#   PROXMOX_HOST=root@192.168.1.10
#   PROVIDER_API_KEY=...
#
# Optional:
#   CTID=151 PORT=48218 STORAGE=local-lvm TEMPLATE_STORAGE=local

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PROXMOX_HOST="${PROXMOX_HOST:-}"
if [ -z "${PROXMOX_HOST}" ]; then
  echo "Set PROXMOX_HOST, for example: PROXMOX_HOST=root@192.168.1.10" >&2
  exit 1
fi

CTID="${CTID:-151}"
CT_HOSTNAME="${CT_HOSTNAME:-nativread-translator}"
PORT="${PORT:-48218}"
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

TRANSLATION_PROVIDER="${TRANSLATION_PROVIDER:-gemini}"
PROVIDER_API_KEY="${PROVIDER_API_KEY:-}"
PROVIDER_MODEL="${PROVIDER_MODEL:-gemini-2.5-flash}"
PROVIDER_BASE_URL="${PROVIDER_BASE_URL:-}"
PROVIDER_REASONER_MODEL="${PROVIDER_REASONER_MODEL:-}"
COST_CEILING_USD="${COST_CEILING_USD:-10}"
TRANSLATION_REFINE="${TRANSLATION_REFINE:-1}"
TRANSLATION_REFINE_SELECTIVE="${TRANSLATION_REFINE_SELECTIVE:-1}"
TRANSLATION_REASONER_HARD="${TRANSLATION_REASONER_HARD:-1}"
TRANSLATION_PRECISION="${TRANSLATION_PRECISION:-balanced}"
TRANSLATION_CONCURRENCY="${TRANSLATION_CONCURRENCY:-4}"

REMOTE_ARCHIVE="/tmp/nativread-translator-src-${CTID}.tgz"
APP_DST="/opt/nativread-translator"
SERVICE_NAME="nativread-translator"

if [ -z "${PROVIDER_API_KEY}" ]; then
  echo "WARNING: PROVIDER_API_KEY is empty; backend will start but real translation will not work." >&2
fi

echo "==> Packing local checkout"
(
  cd "${ROOT_DIR}"
  find . \
    -path ./.git -prune -o \
    -path ./.next -prune -o \
    -path ./node_modules -prune -o \
    -path ./jobs -prune -o \
    -path ./library -prune -o \
    -print0 |
    COPYFILE_DISABLE=1 tar --no-mac-metadata -czf - --null -T -
) | ssh "${PROXMOX_HOST}" "cat > '${REMOTE_ARCHIVE}'"

echo "==> Creating/reusing LXC ${CTID} on ${PROXMOX_HOST}"
ssh "${PROXMOX_HOST}" bash -s <<REMOTE
set -euo pipefail

CTID="${CTID}"
CT_HOSTNAME="${CT_HOSTNAME}"
PORT="${PORT}"
CORES="${CORES}"
MEMORY_MB="${MEMORY_MB}"
DISK_GB="${DISK_GB}"
BRIDGE="${BRIDGE}"
STORAGE="${STORAGE}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE}"
TEMPLATE="${TEMPLATE}"
IPCONFIG="${IPCONFIG}"
GATEWAY="${GATEWAY}"
NODE_MAJOR="${NODE_MAJOR}"
REMOTE_ARCHIVE="${REMOTE_ARCHIVE}"
APP_DST="${APP_DST}"
SERVICE_NAME="${SERVICE_NAME}"

if ! command -v pct >/dev/null 2>&1; then
  echo "pct not found. Run this against the Proxmox host, not inside a VM/container." >&2
  exit 1
fi

if ! pct status "\${CTID}" >/dev/null 2>&1; then
  TEMPLATE_REF="\${TEMPLATE_STORAGE}:vztmpl/\${TEMPLATE}"
  if ! pveam list "\${TEMPLATE_STORAGE}" 2>/dev/null | grep -q "\${TEMPLATE}"; then
    pveam update || true
    pveam download "\${TEMPLATE_STORAGE}" "\${TEMPLATE}"
  fi
  if [ "\${IPCONFIG}" = "dhcp" ]; then
    NET="name=eth0,bridge=\${BRIDGE},ip=dhcp"
  else
    NET="name=eth0,bridge=\${BRIDGE},ip=\${IPCONFIG}\${GATEWAY:+,gw=\$GATEWAY}"
  fi
  pct create "\${CTID}" "\${TEMPLATE_REF}" \
    --hostname "\${CT_HOSTNAME}" \
    --cores "\${CORES}" \
    --memory "\${MEMORY_MB}" \
    --rootfs "\${STORAGE}:\${DISK_GB}" \
    --net0 "\${NET}" \
    --features nesting=1 \
    --unprivileged 1 \
    --onboot 1
else
  echo "CTID \${CTID} exists; reusing it."
fi

pct start "\${CTID}" || true
sleep 6

pct exec "\${CTID}" -- bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates tar >/dev/null
  if ! command -v node >/dev/null || [ \"\\\$(node -v | cut -dv -f2 | cut -d. -f1)\" -lt \${NODE_MAJOR} ]; then
    curl -fsSL https://deb.nodesource.com/setup_\${NODE_MAJOR}.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  fi
"

pct exec "\${CTID}" -- bash -lc "rm -rf '\${APP_DST}' && mkdir -p '\${APP_DST}'"
pct push "\${CTID}" "\${REMOTE_ARCHIVE}" /tmp/nativread-translator-src.tgz
pct exec "\${CTID}" -- bash -lc "tar -xzf /tmp/nativread-translator-src.tgz -C '\${APP_DST}'"

cat > /tmp/nativread-translator.env <<EOF
APP_PROFILE=nativread
TRANSLATION_PROVIDER=${TRANSLATION_PROVIDER}
PROVIDER_API_KEY=${PROVIDER_API_KEY}
PROVIDER_MODEL=${PROVIDER_MODEL}
PROVIDER_BASE_URL=${PROVIDER_BASE_URL}
PROVIDER_REASONER_MODEL=${PROVIDER_REASONER_MODEL}
PORT=${PORT}
HOSTNAME=0.0.0.0
JOBS_DIR=${APP_DST}/data/jobs
LIBRARY_DIR=${APP_DST}/data/library
COST_CEILING_USD=${COST_CEILING_USD}
TRANSLATION_REFINE=${TRANSLATION_REFINE}
TRANSLATION_REFINE_SELECTIVE=${TRANSLATION_REFINE_SELECTIVE}
TRANSLATION_REASONER_HARD=${TRANSLATION_REASONER_HARD}
TRANSLATION_PRECISION=${TRANSLATION_PRECISION}
TRANSLATION_CONCURRENCY=${TRANSLATION_CONCURRENCY}
EOF
pct push "\${CTID}" /tmp/nativread-translator.env "\${APP_DST}/.env"

pct exec "\${CTID}" -- bash -lc "
  set -e
  cd '\${APP_DST}'
  mkdir -p data/jobs data/library
  npm install --no-audit --no-fund
  npm install lightningcss-linux-x64-gnu @tailwindcss/oxide-linux-x64-gnu @next/swc-linux-x64-gnu --no-audit --no-fund
  npm run build
  cp -r .next/static .next/standalone/.next/static
  [ -d public ] && cp -r public .next/standalone/public || true
"

cat > /tmp/nativread-translator.service <<EOF
[Unit]
Description=NativRead translator backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DST}/.next/standalone
ExecStart=/usr/bin/node server.js
EnvironmentFile=${APP_DST}/.env
Environment=NODE_ENV=production
Environment=HOSTNAME=0.0.0.0
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
pct push "\${CTID}" /tmp/nativread-translator.service "/etc/systemd/system/\${SERVICE_NAME}.service"

pct exec "\${CTID}" -- bash -lc "
  systemctl daemon-reload
  systemctl enable '\${SERVICE_NAME}'
  systemctl restart '\${SERVICE_NAME}'
  sleep 2
  systemctl --no-pager status '\${SERVICE_NAME}' | head -n 12 || true
"

IP=\$(pct exec "\${CTID}" -- bash -lc "hostname -I | awk '{print \\\$1}'" 2>/dev/null || echo "<container-ip>")
echo
echo "NativRead backend live at: http://\${IP}:${PORT}"
echo "Logs: pct exec ${CTID} -- journalctl -u ${SERVICE_NAME} -f"
REMOTE
