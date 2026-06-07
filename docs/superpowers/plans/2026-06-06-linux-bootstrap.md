# Linux One-Shot Bootstrap (`Start-SpecR.sh`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `git clone` → `./Start-SpecR.sh` → browser opens the SpecR demo console on Linux, mirroring the Windows one-click bootstrap.

**Architecture:** Single ~300-line bash script at the repo root. Portable Node.js (official nodejs.org tarball) into `.specr-runtime/` when the system lacks v22+; PostgreSQL via the repo's `docker-compose.yml` postgres service with a port-bump contingency; then `pnpm install → migrate → seed → build → node dist/index.js` with an EXIT trap that stops the compose postgres only if this run started it.

**Tech Stack:** bash (`set -Eeuo pipefail`), curl/wget, tar, Docker Compose (v2 plugin or legacy v1 binary), pnpm.

**Spec:** `docs/superpowers/specs/2026-06-06-linux-bootstrap-design.md`
**Branch:** `mockup` (work in `/home/adam/github/SpecR/.claude/worktrees/mockup`; never commit to main)

**Design deviation locked in here (Task 4 backports it to the spec):** the spec said "write `.specr-runtime/compose.port.yml` overriding `services.postgres.ports` and pass both `-f` flags." Compose *appends* `ports` sequences when merging files — the `!override` YAML tag that fixes this needs compose v2.24+, which contradicts the spec's own legacy-v1 support. So the bump path instead writes a **complete standalone** compose file (a copy of the postgres service with the bumped host port) and uses it as the *only* `-f` file, with `--project-directory "$REPO_ROOT"` so the project name — and therefore the `specr_pgdata` volume — stays identical to normal runs. Works on v1 and v2.

---

### Task 1: `.gitattributes` — LF rule for shell scripts

The repo forces CRLF for `*.bat`/`*.ps1`. A CRLF `Start-SpecR.sh` would break with `bash\r: bad interpreter` on checkout-with-autocrlf machines — pin LF before the script exists.

**Files:**
- Modify: `.gitattributes`

- [ ] **Step 1: Append the rule**

Edit `.gitattributes` (repo root, mockup worktree) from:

```gitattributes
# Windows double-click entry points need CRLF in the working tree
*.bat text eol=crlf
*.ps1 text eol=crlf

# UFGS reference fixtures are latin1/CP1252 — never normalize
docs/references/UFGS/** -text
```

to:

```gitattributes
# Windows double-click entry points need CRLF in the working tree
*.bat text eol=crlf
*.ps1 text eol=crlf

# Shell entry points need LF everywhere, even on Windows checkouts
*.sh text eol=lf

# UFGS reference fixtures are latin1/CP1252 — never normalize
docs/references/UFGS/** -text
```

- [ ] **Step 2: Verify the attribute resolves**

Run: `git -C /home/adam/github/SpecR/.claude/worktrees/mockup check-attr text eol -- Start-SpecR.sh`
Expected output:

```
Start-SpecR.sh: text: set
Start-SpecR.sh: eol: lf
```

- [ ] **Step 3: Commit**

```bash
git -C /home/adam/github/SpecR/.claude/worktrees/mockup add .gitattributes
git -C /home/adam/github/SpecR/.claude/worktrees/mockup commit -m "chore(scripts): force LF for *.sh entry points"
```

---

### Task 2: Write `Start-SpecR.sh`

**Files:**
- Create: `Start-SpecR.sh` (repo root, mode 755)

- [ ] **Step 1: Write the complete script**

Create `/home/adam/github/SpecR/.claude/worktrees/mockup/Start-SpecR.sh` with exactly this content:

```bash
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
```

- [ ] **Step 2: Make it executable and syntax-check**

```bash
chmod 755 /home/adam/github/SpecR/.claude/worktrees/mockup/Start-SpecR.sh
bash -n /home/adam/github/SpecR/.claude/worktrees/mockup/Start-SpecR.sh
```

Expected: `bash -n` prints nothing, exit 0.

- [ ] **Step 3: shellcheck**

Run: `shellcheck /home/adam/github/SpecR/.claude/worktrees/mockup/Start-SpecR.sh`
Expected: no findings, exit 0. If shellcheck is not installed and cannot be installed without sudo, record "shellcheck unavailable on dev box" in the commit body and rely on `bash -n` + the Task 3 runtime matrix.

If shellcheck reports findings: fix legitimate ones; for false positives add a targeted `# shellcheck disable=SCnnnn` directive on the offending line with a trailing reason comment.

- [ ] **Step 4: Verify git records LF + 100755**

```bash
git -C /home/adam/github/SpecR/.claude/worktrees/mockup add Start-SpecR.sh
git -C /home/adam/github/SpecR/.claude/worktrees/mockup ls-files -s Start-SpecR.sh
```

Expected: mode `100755`, and `git check-attr eol -- Start-SpecR.sh` says `lf`.

- [ ] **Step 5: Commit**

```bash
git -C /home/adam/github/SpecR/.claude/worktrees/mockup commit -m "feat(scripts): one-shot Linux bootstrap (Start-SpecR.sh)"
```

---

### Task 3: Runtime verification matrix

No unit tests (repo precedent for bootstrap scripts — spec §Verification). All commands run from `/home/adam/github/SpecR/.claude/worktrees/mockup`.

- [ ] **Step 1: Broken-daemon error path** (the dev box's Docker daemon is currently broken — exercise it as-is)

Run: `./Start-SpecR.sh; echo "exit=$?"`
Expected: intro banner → CA step → Node found (system node exists here) → pnpm found → `==> Checking PostgreSQL` → `FAILED: the Docker daemon is not reachable.` with the systemctl/usermod/SPECR_DATABASE_URL remedies → `exit=1`. No compose postgres started, no `pnpm install` reached.

- [ ] **Step 2: App-port collision path** (uses SPECR_DATABASE_URL to bypass Docker; collision check fires before any pnpm step)

```bash
python3 -m http.server 39999 >/dev/null 2>&1 &
HTTP_PID=$!
SPECR_DATABASE_URL='postgresql://specr:specr@localhost:5432/specr' SPECR_PORT=39999 ./Start-SpecR.sh; echo "exit=$?"
kill $HTTP_PID
```

Expected: `using existing database: SPECR_DATABASE_URL` (Docker never touched) → `FAILED: port 39999 is already in use -- close the other program or set SPECR_PORT to a free port and re-run` → `exit=1`.

- [ ] **Step 3: Input-validation path**

Run: `SPECR_PG_PORT=abc ./Start-SpecR.sh; echo "exit=$?"`
Expected: `FAILED: SPECR_PG_PORT must be a number, got 'abc'` → `exit=1`.

- [ ] **Step 4: Happy path — only if the user restores the Docker daemon**

Ask the user to run `sudo systemctl restart docker` (or confirm it's fine to skip). If restored:

```bash
rm -rf .specr-runtime           # simulate a fresh clone (cache cold)
./Start-SpecR.sh
```

Expected: postgres pulled/started → `PostgreSQL ready on port 5432` → install/migrate/seed/build green → banner → browser tab opens on the console → Ctrl+C stops the server, then `==> Stopping compose PostgreSQL` runs, exit 0 (or 130 via signal — either is acceptable as propagation). Re-run immediately: `compose postgres already running on port 5432` must NOT appear (we stopped it), instead container restarts quickly reusing the volume; cached paths print "reusing/already downloaded" where applicable.

If the daemon stays broken: record in the final report that Steps 1–3 passed and Step 4 is blocked on the host's Docker daemon (the script's own error path covers this gracefully).

- [ ] **Step 5: Fix anything the matrix surfaced, amend or follow-up commit**

Any behavioral fix gets its own commit: `fix(scripts): <symptom>`.

---

### Task 4: Backport the merge-semantics correction to the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-06-06-linux-bootstrap-design.md` (the bullet describing `compose.port.yml` in Flow §4)

- [ ] **Step 1: Replace the override bullet**

Old text (one bullet):

```
   - Else choose a host port: start at `SPECR_PG_PORT`; while busy (bash
     `/dev/tcp` probe) bump +1 up to +20; exhausted → die. If the chosen port
     ≠ 5432, write `.specr-runtime/compose.port.yml` overriding
     `services.postgres.ports` to `["<port>:5432"]` and add `-f` flags for
     both files to every compose invocation this run.
```

New text:

```
   - Else choose a host port: start at `SPECR_PG_PORT`; while busy (bash
     `/dev/tcp` probe) bump +1 up to +20; exhausted → die. If the chosen port
     ≠ 5432, write `.specr-runtime/compose.port.yml` as a complete standalone
     copy of the postgres service publishing `<port>:5432`, and use it as the
     only `-f` file with `--project-directory <repo>` so the project name and
     `specr_pgdata` volume stay identical. (Compose merges `ports` lists by
     appending; the `!override` tag needs v2.24+, which would break the
     legacy-v1 support promised above.)
```

- [ ] **Step 2: Commit**

```bash
git -C /home/adam/github/SpecR/.claude/worktrees/mockup add docs/superpowers/specs/2026-06-06-linux-bootstrap-design.md
git -C /home/adam/github/SpecR/.claude/worktrees/mockup commit -m "docs(specs): linux bootstrap — standalone compose file on bump path (ports merge semantics)"
```

---

### Task 5: Push

- [ ] **Step 1: Confirm with the user, then push the mockup branch**

```bash
git -C /home/adam/github/SpecR/.claude/worktrees/mockup push origin mockup
```

Expected: fast-forward push (no force needed — these are new commits on the already-rebased tip).
