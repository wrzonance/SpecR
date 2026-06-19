#!/usr/bin/env bash
set -Eeuo pipefail

EXAMPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_ROOT/../.." && pwd)"
DATABASE_URL_CHOSEN="${DATABASE_URL:-postgres://specr:specr@localhost:5432/specr}"
API_PID=""

# True (0) when the port can be bound. Asks Node to bind it — the same operation
# the API/demo servers perform — which is more reliable than /dev/tcp (often
# compiled out) or ss/lsof/nc (not always installed); Node is already required.
port_is_free() {
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.once("listening",()=>s.close(()=>process.exit(0)));s.listen(Number(process.argv[1]),"0.0.0.0");' "$1" 2>/dev/null
}

# Prints the first free port at or after $1, skipping the optional $2 (so the
# web port never lands on the API port). Other dev servers commonly squat 3000+,
# so we hunt for a free port instead of failing on a conflict.
find_free_port() {
  local port="$1" avoid="${2:-}" limit
  limit=$((port + 50))
  while [[ "$port" -le "$limit" ]]; do
    if [[ "$port" != "$avoid" ]] && port_is_free "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  printf 'no free port found at or after %s\n' "$1" >&2
  return 1
}

API_PORT_WANTED="${SPECR_PORT:-3000}"
WEB_PORT_WANTED="${SPECR_WEB_PORT:-3001}"
API_PORT="$(find_free_port "$API_PORT_WANTED")"
WEB_PORT="$(find_free_port "$WEB_PORT_WANTED" "$API_PORT")"
[[ "$API_PORT" == "$API_PORT_WANTED" ]] ||
  printf '==> Port %s busy; using %s for the SpecR API\n' "$API_PORT_WANTED" "$API_PORT"
[[ "$WEB_PORT" == "$WEB_PORT_WANTED" ]] ||
  printf '==> Port %s busy; using %s for the web UI demo\n' "$WEB_PORT_WANTED" "$WEB_PORT"

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
