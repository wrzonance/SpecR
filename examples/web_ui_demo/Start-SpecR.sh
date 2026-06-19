#!/usr/bin/env bash
set -Eeuo pipefail

EXAMPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_ROOT/../.." && pwd)"
API_PORT="${SPECR_PORT:-3000}"
WEB_PORT="${SPECR_WEB_PORT:-3001}"
DATABASE_URL_CHOSEN="${DATABASE_URL:-postgres://specr:specr@localhost:5432/specr}"
API_PID=""

cleanup() {
  if [[ -n "$API_PID" ]]; then
    kill "$API_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

printf '\n==> Building and starting SpecR API from %s\n' "$REPO_ROOT"
cd "$REPO_ROOT"
export DATABASE_URL="$DATABASE_URL_CHOSEN"
export NODE_ENV="${NODE_ENV:-production}"
export PORT="$API_PORT"

pnpm install --frozen-lockfile
pnpm migrate
pnpm seed
pnpm build

node dist/index.js &
API_PID="$!"

printf '\n==> Waiting for the SpecR API on http://127.0.0.1:%s\n' "$API_PORT"
api_ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    api_ready=1
    break
  fi
  sleep 0.5
done
if [[ "$api_ready" -ne 1 ]]; then
  printf 'SpecR API did not become ready on port %s after ~30s\n' "$API_PORT" >&2
  exit 1
fi

printf '\n==> Starting web UI demo from %s\n' "$EXAMPLE_ROOT"
printf '    API:  http://127.0.0.1:%s\n' "$API_PORT"
printf '    Demo: http://127.0.0.1:%s\n\n' "$WEB_PORT"

cd "$EXAMPLE_ROOT"
SPECR_API_BASE="http://127.0.0.1:$API_PORT" PORT="$WEB_PORT" node server.mjs
