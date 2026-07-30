#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.nativread"
EXAMPLE_FILE="${ROOT_DIR}/.env.nativread.example"

cd "${ROOT_DIR}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH." >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  cp "${EXAMPLE_FILE}" "${ENV_FILE}"
  cat >&2 <<'MSG'
Created .env.nativread.

Edit PROVIDER_API_KEY in .env.nativread, then run:
  bash scripts/setup-nativread-backend.sh
MSG
  exit 0
fi

docker compose --env-file "${ENV_FILE}" -f docker-compose.nativread.yml up -d --build
docker compose --env-file "${ENV_FILE}" -f docker-compose.nativread.yml ps

PORT="$(grep -E '^NATIVREAD_TRANSLATOR_PORT=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)"
PORT="${PORT:-48218}"

cat <<MSG

NativRead backend is starting.

Simulator URL:
  http://127.0.0.1:${PORT}

Real iPhone URL:
  http://<this-host-lan-ip>:${PORT}
MSG
