#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# SpecR one-shot bootstrap for Linux.
#
# Run from a clone:  ./Start-SpecR.sh
#
# Portable Node.js (only if the system lacks v22+) lands in
# <repo>/.specr-runtime -- no root, nothing system-wide, fully removable by
# deleting that folder. PostgreSQL runs via the repo's docker-compose.yml
# postgres service. Re-runs reuse everything already downloaded or running.
#
# Overrides (set as environment variables before launching):
#   SPECR_PORT          HTTP port for the server            (default 3000)
#   SPECR_PG_PORT       host port for compose PostgreSQL    (default 5432)
#   SPECR_DATABASE_URL  use an existing PostgreSQL; skips Docker entirely
#   SPECR_NODE_VERSION  portable Node.js version            (default 22.14.0)
#   SPECR_NO_SYSTEM_CA  set to 1 to skip exporting the system CA bundle
# -----------------------------------------------------------------------------
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$REPO_ROOT/.specr-runtime"
APP_PORT="${SPECR_PORT:-3000}"
PG_PORT="${SPECR_PG_PORT:-5432}"
NODE_VERSION="${SPECR_NODE_VERSION:-22.14.0}"

# -- output helpers -----------------------------------------------------------

if [[ -t 1 ]]; then
  C_STEP=$'\e[36m' C_OK=$'\e[32m' C_NOTE=$'\e[33m' C_CMD=$'\e[2;36m'
  C_ERR=$'\e[31m' C_RESET=$'\e[0m'
else
  C_STEP='' C_OK='' C_NOTE='' C_CMD='' C_ERR='' C_RESET=''
fi

step() { printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_RESET"; }
ok()   { printf '%s    %s%s\n' "$C_OK" "$1" "$C_RESET"; }
note() { printf '%s    %s%s\n' "$C_NOTE" "$1" "$C_RESET"; }
cmd()  { printf '%s    >> %s%s\n' "$C_CMD" "$1" "$C_RESET"; }
die()  { printf '\n%s    FAILED: %s%s\n' "$C_ERR" "$1" "$C_RESET" >&2; exit 1; }

# True when something is listening on 127.0.0.1:$1.
port_busy() {
  timeout 1 bash -c "exec 2>/dev/null; echo > /dev/tcp/127.0.0.1/$1"
}

# Runs a command, echoing it first and streaming its output indented, so tool
# chatter stays visually subordinate to the step lines. Returns the command's
# own exit code (pipefail makes the sed pipe transparent).
run_logged() {
  local label="$1" rc=0
  shift
  cmd "$label"
  "$@" 2>&1 | sed 's/^/       /' || rc="${PIPESTATUS[0]}"
  return "$rc"
}

# Cached download: skips when $2 already exists; partial-file safe.
download() {
  local url="$1" dest="$2" what="$3"
  if [[ -f "$dest" ]]; then
    ok "$what already downloaded -- using cached $(basename "$dest")"
    return 0
  fi
  note "downloading $what"
  printf '    from %s\n' "$url"
  local tmp="$dest.partial"
  if command -v curl >/dev/null 2>&1; then
    curl -fL -# -o "$tmp" "$url" || die "download failed: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$tmp" "$url" || die "download failed: $url"
  else
    die "need curl or wget to download $what"
  fi
  mv "$tmp" "$dest"
  ok "saved $(basename "$dest")"
}

# -- TLS trust ----------------------------------------------------------------

# Node ships its own CA bundle and ignores the system store. Behind a
# TLS-inspecting proxy the corporate root lives in the system bundle but not
# in Node's, and every registry request dies with
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY. Pointing NODE_EXTRA_CA_CERTS at the
# distro bundle fixes that WITHOUT disabling verification.
export_system_ca() {
  if [[ -n "${SPECR_NO_SYSTEM_CA:-}" ]]; then
    note 'SPECR_NO_SYSTEM_CA set -- skipping system CA export'
    return 0
  fi
  local bundle
  for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do
    if [[ -r "$bundle" ]]; then
      export NODE_EXTRA_CA_CERTS="$bundle"
      ok "NODE_EXTRA_CA_CERTS=$bundle"
      return 0
    fi
  done
  note 'no system CA bundle found -- continuing with Node defaults'
}

# -- Node.js ------------------------------------------------------------------

node_is_v22() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node --version)"
  major="${major#v}"
  major="${major%%.*}"
  [[ "$major" -ge 22 ]]
}

install_portable_node() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported architecture $(uname -m) -- install Node.js v22+ yourself and re-run" ;;
  esac
  local dir="$RUNTIME/node-v$NODE_VERSION-linux-$arch"
  if [[ ! -x "$dir/bin/node" ]]; then
    local tarball="$RUNTIME/node-v$NODE_VERSION-linux-$arch.tar.gz"
    download "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.gz" \
      "$tarball" "Node.js v$NODE_VERSION (portable)"
    note "extracting $(basename "$tarball") -> $dir"
    tar -xzf "$tarball" -C "$RUNTIME" || die "could not extract $(basename "$tarball")"
    ok 'extraction complete'
  else
    ok "reusing portable Node.js already extracted at $dir"
  fi
  PATH="$dir/bin:$PATH"
  ok "Node.js $(node --version) (portable) now first on PATH"
}

ensure_node() {
  step 'Checking Node.js (need v22+)'
  if node_is_v22; then
    ok "Node.js $(node --version) found at $(command -v node)"
  else
    note 'no Node.js v22+ on PATH -- fetching a portable copy'
    install_portable_node
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm --version) found at $(command -v pnpm)"
    return 0
  fi
  note 'pnpm not found -- installing with npm (npm output follows)'
  if ! run_logged 'npm install --global pnpm' npm install --global --no-fund pnpm; then
    # System Node without write access to its global prefix (apt/dnf installs
    # default to /usr) -- switch to portable Node, whose prefix is ours.
    note 'npm install failed -- switching to portable Node.js and retrying'
    install_portable_node
    run_logged 'npm install --global pnpm (portable Node)' npm install --global --no-fund pnpm || die "could not install pnpm -- no internet, or a proxy blocking registry.npmjs.org? Install pnpm yourself (https://pnpm.io/installation) and re-run"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    # npm puts global bins in its prefix, which may not be on PATH yet.
    PATH="$(npm prefix -g)/bin:$PATH"
  fi
  command -v pnpm >/dev/null 2>&1 || die "npm reported success but pnpm is not callable -- open a new shell, check 'pnpm --version', and re-run"
  ok "pnpm $(pnpm --version) installed at $(command -v pnpm)"
}

# -- PostgreSQL (Docker Compose) ----------------------------------------------

COMPOSE=()          # docker compose | docker-compose
COMPOSE_ARGS=()     # --project-directory <repo> -f <active yml>
STARTED_PG=0
DATABASE_URL_CHOSEN=''
WATCH_PID=''

resolve_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    die "Docker Compose not found -- install Docker Engine + the compose plugin (https://docs.docker.com/engine/install/), or set SPECR_DATABASE_URL to use an existing PostgreSQL"
  fi
  COMPOSE_ARGS=(--project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker-compose.yml")
  ok "using ${COMPOSE[*]}"
}

check_docker_daemon() {
  docker info >/dev/null 2>&1 && return 0
  die "the Docker daemon is not reachable.
    Try:   sudo systemctl start docker     (then re-run this script)
    Check: systemctl status docker
    'permission denied'? -> sudo usermod -aG docker ${USER:-$(id -un)}, then log out and back in.
    No Docker at all? Set SPECR_DATABASE_URL to an existing PostgreSQL and re-run."
}

# Bump path: compose APPENDS `ports` lists when merging -f files (!override
# needs v2.24+), so we replace the file wholesale instead of overriding.
# --project-directory keeps the project name (and the specr_pgdata volume)
# identical to plain docker-compose.yml runs.
# KEEP THE SERVICE DEFINITION IN SYNC WITH docker-compose.yml.
write_port_compose() {
  cat > "$RUNTIME/compose.port.yml" <<EOF
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: specr
      POSTGRES_PASSWORD: specr
      POSTGRES_DB: specr
    ports:
      - "$1:5432"
    volumes:
      - specr_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U specr"]
      interval: 5s
      timeout: 5s
      retries: 5

volumes:
  specr_pgdata:
EOF
  COMPOSE_ARGS=(--project-directory "$REPO_ROOT" -f "$RUNTIME/compose.port.yml")
}

ensure_postgres() {
  step 'Checking PostgreSQL'
  if [[ -n "${SPECR_DATABASE_URL:-}" ]]; then
    ok 'using existing database: SPECR_DATABASE_URL'
    DATABASE_URL_CHOSEN="$SPECR_DATABASE_URL"
    return 0
  fi

  resolve_compose
  check_docker_daemon

  # A live container from an earlier run? `port` reads the real published
  # port off the running container, whichever file created it.
  local mapping
  mapping="$("${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" port postgres 5432 2>/dev/null || true)"
  local pg_port=''
  if [[ "$mapping" =~ :([0-9]+)[[:space:]]*$ ]]; then
    pg_port="${BASH_REMATCH[1]}"
    ok "compose postgres already running on port $pg_port"
  else
    pg_port="$PG_PORT"
    local max_port=$((PG_PORT + 20))
    while port_busy "$pg_port" && [[ "$pg_port" -lt "$max_port" ]]; do
      note "port $pg_port is in use by another program -- trying $((pg_port + 1))"
      pg_port=$((pg_port + 1))
    done
    port_busy "$pg_port" && die "no free PostgreSQL port in range $PG_PORT..$max_port -- set SPECR_PG_PORT"
    if [[ "$pg_port" != 5432 ]]; then
      note "publishing PostgreSQL on bumped port $pg_port via .specr-runtime/compose.port.yml"
      write_port_compose "$pg_port"
    fi
    cmd "${COMPOSE[*]} up -d postgres"
    "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" up -d postgres || die "compose up failed -- scroll up for Docker's own error output"
    STARTED_PG=1
  fi

  note 'probing the server with pg_isready (up to 30s) ...'
  local deadline=$((SECONDS + 30))
  until "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" exec -T postgres pg_isready -U specr -q >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      note 'last 40 lines of the postgres container log:'
      "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" logs --tail 40 postgres || true
      die "PostgreSQL did not become ready on port $pg_port"
    fi
    sleep 1
  done
  ok "PostgreSQL ready on port $pg_port (data: compose volume specr_pgdata)"
  DATABASE_URL_CHOSEN="postgresql://specr:specr@localhost:$pg_port/specr"
}

stop_postgres() {
  [[ "$STARTED_PG" == 1 ]] || return 0
  step 'Stopping compose PostgreSQL'
  # stop, not down: container + volume survive for fast re-runs
  "${COMPOSE[@]}" "${COMPOSE_ARGS[@]}" stop postgres || true
}

# -- App build + run ----------------------------------------------------------

pnpm_step() {
  local what="$1"
  shift
  cmd "pnpm $*"
  pnpm "$@" || die "$what failed (pnpm $*)"
}

open_browser_when_ready() {
  if ! command -v xdg-open >/dev/null 2>&1 || [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    note "no GUI session detected -- open http://localhost:$APP_PORT yourself"
    return 0
  fi
  note 'a browser tab will open as soon as the server answers on the port'
  (
    deadline=$((SECONDS + 60))
    while ((SECONDS < deadline)); do
      if port_busy "$APP_PORT"; then
        xdg-open "http://localhost:$APP_PORT" >/dev/null 2>&1 || true
        exit 0
      fi
      sleep 0.5
    done
  ) &
  WATCH_PID=$!
}

start_specr() {
  cd "$REPO_ROOT"
  if port_busy "$APP_PORT"; then
    die "port $APP_PORT is already in use -- close the other program or set SPECR_PORT to a free port and re-run"
  fi
  export DATABASE_URL="$DATABASE_URL_CHOSEN"
  export NODE_ENV=production
  export PORT="$APP_PORT"
  note "environment: PORT=$PORT NODE_ENV=production DATABASE_URL=$DATABASE_URL"

  step 'Installing dependencies'
  pnpm_step 'dependency install' install --frozen-lockfile

  step 'Running database migrations + seeding the CSI section catalog'
  pnpm_step 'migrations' migrate
  pnpm_step 'seed' seed

  step 'Building the server'
  pnpm_step 'build' build

  step "Starting SpecR on http://localhost:$APP_PORT"
  printf '\n'
  printf '%s    +---------------------------------------------------+%s\n' "$C_OK" "$C_RESET"
  printf '%s    |  SpecR console:  http://localhost:%-5s           |%s\n' "$C_OK" "$APP_PORT" "$C_RESET"
  printf '%s    |  Drop .SEC / .DOCX spec sections onto the page.   |%s\n' "$C_OK" "$C_RESET"
  printf '%s    |  Press Ctrl+C in this window to stop the server.  |%s\n' "$C_OK" "$C_RESET"
  printf '%s    +---------------------------------------------------+%s\n' "$C_OK" "$C_RESET"
  printf '\n'

  open_browser_when_ready

  local app_exit=0
  node dist/index.js || app_exit=$?
  return "$app_exit"
}

# -- Main ---------------------------------------------------------------------

cleanup() {
  local code=$?
  if [[ -n "$WATCH_PID" ]]; then
    kill "$WATCH_PID" 2>/dev/null || true
  fi
  stop_postgres
  exit "$code"
}

main() {
  printf '\n  === SpecR -- one-shot bootstrap (Linux) ===\n'
  printf '  repo:    %s\n' "$REPO_ROOT"
  printf '  runtime: %s\n' "$RUNTIME"
  [[ "$(uname -s)" == Linux ]] || die 'Linux only -- double-click Start-SpecR.bat on Windows'
  [[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "SPECR_PORT must be a number, got '$APP_PORT'"
  [[ "$PG_PORT" =~ ^[0-9]+$ ]] || die "SPECR_PG_PORT must be a number, got '$PG_PORT'"
  mkdir -p "$RUNTIME"

  step 'Preparing TLS trust for Node.js (system CA bundle)'
  export_system_ca

  ensure_node
  ensure_pnpm
  ensure_postgres
  start_specr
}

trap cleanup EXIT
main "$@"
