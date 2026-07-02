#!/usr/bin/env bash
set -Eeuo pipefail

EXAMPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EXAMPLE_ROOT/../.." && pwd)"
if [[ -n "${DATABASE_URL:-}" ]]; then
  DATABASE_URL_WAS_SUPPLIED=1
else
  DATABASE_URL_WAS_SUPPLIED=0
fi
DATABASE_URL_CHOSEN="${DATABASE_URL:-postgres://specr:specr@localhost:5432/specr}"
API_PID=""
PNPM_REQUIRED_VERSION="11.0.0"
PNPM_REQUIRED_MAJOR="${PNPM_REQUIRED_VERSION%%.*}"
PNPM_COMMAND=(pnpm)

# True (0) when the port can be bound. Asks Node to bind it — the same operation
# the API/demo servers perform — which is more reliable than /dev/tcp (often
# compiled out) or ss/lsof/nc (not always installed); Node is already required.
port_is_free() {
  node -e 'const s=require("net").createServer();s.once("error",()=>process.exit(1));s.once("listening",()=>s.close(()=>process.exit(0)));s.listen(Number(process.argv[1]),"0.0.0.0");' "$1" 2>/dev/null
}

# Prints the first free port at or after $1, skipping any additional arguments
# so the API, demo, and Docker database host ports never collide. Other dev
# servers commonly squat 3000+, so we hunt for a free port instead of failing.
port_is_avoided() {
  local port="$1" avoid
  shift
  for avoid in "$@"; do
    if [[ -n "$avoid" && "$port" == "$avoid" ]]; then
      return 0
    fi
  done
  return 1
}

find_free_port() {
  local port="$1" limit
  shift
  limit=$((port + 50))
  while [[ "$port" -le "$limit" ]]; do
    if ! port_is_avoided "$port" "$@" && port_is_free "$port"; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
  done
  printf 'no free port found at or after %s\n' "$1" >&2
  return 1
}

pnpm_version_satisfies() {
  local version="${1:-}" major="" minor="" patch=""
  version="${version%%-*}"
  IFS=. read -r major minor patch <<< "$version"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= PNPM_REQUIRED_MAJOR))
}

activate_corepack_pnpm() {
  if corepack install -g -h >/dev/null 2>&1; then
    corepack install -g "pnpm@$PNPM_REQUIRED_VERSION"
    return
  fi
  corepack prepare "pnpm@$PNPM_REQUIRED_VERSION" --activate
}

ensure_pnpm() {
  local current=""
  if command -v pnpm >/dev/null 2>&1; then
    current="$(pnpm -v 2>/dev/null || true)"
    if pnpm_version_satisfies "$current"; then
      PNPM_COMMAND=(pnpm)
      return 0
    fi
    printf '==> pnpm %s does not satisfy >=%s; activating pnpm %s with Corepack\n' \
      "${current:-unknown}" "$PNPM_REQUIRED_VERSION" "$PNPM_REQUIRED_VERSION"
  else
    printf '==> pnpm not found; activating pnpm %s with Corepack\n' "$PNPM_REQUIRED_VERSION"
  fi

  if ! command -v corepack >/dev/null 2>&1; then
    printf 'pnpm >=%s is required, and Corepack was not found. Install Node.js with Corepack or pnpm >=%s, then re-run.\n' \
      "$PNPM_REQUIRED_VERSION" "$PNPM_REQUIRED_VERSION" >&2
    return 1
  fi
  if ! activate_corepack_pnpm; then
    printf 'Corepack could not install pnpm %s. Check network/proxy access to the npm registry, then re-run.\n' \
      "$PNPM_REQUIRED_VERSION" >&2
    return 1
  fi

  PNPM_COMMAND=(corepack pnpm)
  current="$("${PNPM_COMMAND[@]}" -v 2>/dev/null || true)"
  if ! pnpm_version_satisfies "$current"; then
    printf 'Corepack activated pnpm %s, but SpecR requires >=%s.\n' \
      "${current:-unknown}" "$PNPM_REQUIRED_VERSION" >&2
    return 1
  fi
  printf '==> Using pnpm %s via Corepack\n' "$current"
}

run_pnpm() {
  "${PNPM_COMMAND[@]}" "$@"
}

tcp_is_open() {
  node -e '
    const net = require("net");
    const host = process.argv[1];
    const port = Number(process.argv[2]);
    const timeout = Number(process.argv[3]);
    const socket = net.createConnection({ host, port });
    const done = (code) => {
      socket.destroy();
      process.exit(code);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(0));
    socket.once("timeout", () => done(1));
    socket.once("error", () => done(1));
  ' "$1" "$2" "${3:-1000}" >/dev/null 2>&1
}

parse_database_endpoint() {
  node -e '
    try {
      const url = new URL(process.argv[1]);
      const port = url.port || "5432";
      if (!url.hostname) process.exit(1);
      console.log(`${url.hostname} ${port}`);
    } catch {
      process.exit(1);
    }
  ' "$1"
}

get_compose_postgres_port() {
  local out=""
  out="$(docker compose port postgres 5432 2>/dev/null || true)"
  out="${out%%$'\n'*}"
  if [[ "$out" =~ :([0-9]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

DOCKER_DATABASE_PORT=""
initialize_docker_database() {
  local running="" port="" i
  running="$(get_compose_postgres_port || true)"
  if [[ -n "$running" ]] && tcp_is_open localhost "$running"; then
    printf '==> Reusing running compose PostgreSQL on host port %s\n' "$running"
    DOCKER_DATABASE_PORT="$running"
    return 0
  fi

  port="$(find_free_port "${SPECR_DB_HOST_PORT:-5432}" "$API_PORT" "$WEB_PORT")"
  printf '==> Starting bundled PostgreSQL (docker compose) on host port %s\n' "$port"
  export SPECR_DB_HOST_PORT="$port"
  docker compose up -d postgres

  printf '==> Waiting for PostgreSQL on localhost:%s\n' "$port"
  for i in $(seq 1 60); do
    if tcp_is_open localhost "$port"; then
      DOCKER_DATABASE_PORT="$port"
      return 0
    fi
    sleep 1
  done

  printf 'PostgreSQL did not become ready on host port %s after ~60s\n' "$port" >&2
  return 1
}

initialize_database() {
  local endpoint="" db_host="" db_port=""
  if ! endpoint="$(parse_database_endpoint "$DATABASE_URL")"; then
    printf '==> Could not parse DATABASE_URL host/port; leaving it to pnpm migrate\n'
    return 0
  fi
  read -r db_host db_port <<< "$endpoint"

  if tcp_is_open "$db_host" "$db_port"; then
    printf '==> PostgreSQL reachable at %s:%s\n' "$db_host" "$db_port"
    return 0
  fi

  if [[ "$DATABASE_URL_WAS_SUPPLIED" == "1" ]]; then
    printf 'DATABASE_URL points at %s:%s, which is not reachable. Start that database or fix DATABASE_URL.\n' \
      "$db_host" "$db_port" >&2
    return 1
  fi

  printf '==> PostgreSQL not reachable at %s:%s\n' "$db_host" "$db_port"
  if ! command -v docker >/dev/null 2>&1; then
    printf 'PostgreSQL is not running and Docker was not found. Start PostgreSQL, install Docker, or set DATABASE_URL to an existing server, then re-run.\n' >&2
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    printf 'PostgreSQL is not running and Docker Compose is not available. Install Docker Compose or set DATABASE_URL to an existing server, then re-run.\n' >&2
    return 1
  fi

  initialize_docker_database
  export DATABASE_URL="postgres://specr:specr@localhost:$DOCKER_DATABASE_PORT/specr"
  printf '==> SpecR API will use %s\n' "$DATABASE_URL"
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

ensure_pnpm
run_pnpm install --frozen-lockfile
initialize_database
run_pnpm migrate
run_pnpm seed
run_pnpm build

# Hand the demo env to the API so its rate-limit opt-out (DISABLE_RATE_LIMIT=true) reaches
# the API process. Load the committed .env.example first — so the opt-out works on a clean
# checkout where the gitignored .env does not exist — then let a real .env override it.
# Node's --env-file does NOT override already-exported vars (so DATABASE_URL/NODE_ENV/PORT
# above still win), and a later --env-file overrides an earlier one.
node --env-file-if-exists="$EXAMPLE_ROOT/.env.example" --env-file-if-exists="$EXAMPLE_ROOT/.env" dist/index.js &
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
