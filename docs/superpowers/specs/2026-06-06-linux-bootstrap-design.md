# Linux One-Shot Bootstrap (`Start-SpecR.sh`) — Design

Date: 2026-06-06
Branch: `mockup`
Status: Approved

## Context

The mockup branch ships a Windows one-click bootstrap (`Start-SpecR.bat` +
`scripts/windows/Start-SpecR.ps1`): portable Node.js + portable PostgreSQL into
`.specr-runtime/`, no admin rights, cached re-runs, browser auto-open. Linux
machines have no equivalent — this spec defines one.

Decisions made during brainstorming:

1. **PostgreSQL comes from Docker** (the repo's existing `docker-compose.yml`
   postgres service), not from system packages or portable binaries. Chosen by
   the user over a system-binaries-first chain.
2. **Single root script** `Start-SpecR.sh`, sibling to `Start-SpecR.bat`. The
   Windows bat→ps1 split exists only to dodge PowerShell execution policy;
   bash needs no launcher pair.
3. **Full Windows-parity robustness** (approach B): portable-Node fallback,
   daemon checks with actionable errors, port auto-bump, readiness probes,
   browser auto-open, clean shutdown — not a minimal glue script.

## Goals

- `git clone` → `./Start-SpecR.sh` → browser opens the demo console, on a
  Linux box whose only prerequisites are bash, curl-or-wget, tar, and a
  working Docker daemon with compose.
- Re-runs reuse everything already downloaded/created (idempotent).
- Everything the script provisions lands under `.specr-runtime/` (plus the
  compose container/volume); deleting that folder + `docker compose down -v`
  fully resets.
- Every failure mode prints a remedy, not just an error.

## Non-Goals / Out of Scope

- No podman support, no macOS, no musl/Alpine, no arm32.
- No portable-PostgreSQL or system-PostgreSQL provisioning paths.
- No changes to `docker-compose.yml`, the Windows scripts, or `src/`.
- No CI coverage (matches the Windows scripts' precedent).

## Interface

File: `Start-SpecR.sh`, repo root, mode 755, LF endings (`.gitattributes`
gains `*.sh text eol=lf`). Refuses non-Linux (`uname -s` ≠ Linux → die).

Environment overrides (parity with the ps1 where applicable):

| Variable             | Default   | Meaning                                          |
| -------------------- | --------- | ------------------------------------------------ |
| `SPECR_PORT`         | `3000`    | app HTTP port (die if busy — no bump, as on Windows) |
| `SPECR_PG_PORT`      | `5432`    | host port for compose postgres; bump start point |
| `SPECR_DATABASE_URL` | —         | use an existing PostgreSQL; skip Docker entirely |
| `SPECR_NODE_VERSION` | `22.14.0` | portable Node version                            |
| `SPECR_NO_SYSTEM_CA` | —         | skip `NODE_EXTRA_CA_CERTS` export                |

`SPECR_PG_VERSION` is intentionally absent: the compose file pins
`postgres:16`.

## Flow

`set -Eeuo pipefail`; repo root = script's own directory; runtime dir
`.specr-runtime/`.

1. **Helpers.** `step`/`ok`/`note`/`die` echo with ANSI colors only when
   stdout is a tty. `download <url> <dest> <label>`: skip if `<dest>` exists
   (cached), stream via `curl -fL -#` else `wget`, write to `<dest>.partial`,
   atomic `mv` on success. `run_logged <label> <cmd...>`: echo the command,
   stream output indented, return its exit code.
2. **CA trust.** Unless `SPECR_NO_SYSTEM_CA` is set, export
   `NODE_EXTRA_CA_CERTS` to the first existing of
   `/etc/ssl/certs/ca-certificates.crt` (Debian/Ubuntu/Arch) or
   `/etc/pki/tls/certs/ca-bundle.crt` (Fedora/RHEL). Same corporate-proxy
   rationale as the Windows CA export; harmless otherwise.
3. **Node.js.** Accept any PATH `node` with major ≥ 22. Otherwise download the
   official portable tarball
   `https://nodejs.org/dist/v$V/node-v$V-linux-$ARCH.tar.gz`
   (`x86_64`→`x64`, `aarch64`→`arm64`, anything else → die) into the runtime
   dir, extract (cached), prepend its `bin/` to `PATH`. Then pnpm: if absent,
   `npm install --global --no-fund pnpm`; if `pnpm` still not callable,
   prepend `$(npm prefix -g)/bin` to `PATH`; still absent → die with the
   pnpm.io install hint. (No corepack — parity with the Windows script and
   corepack's deprecation trajectory.)
4. **PostgreSQL (compose).**
   - `SPECR_DATABASE_URL` set → use it verbatim, skip this section, never
     touch Docker.
   - Resolve compose command: `docker compose version` works → `docker
     compose`; else `docker-compose` on PATH; else die ("install the compose
     plugin").
   - `docker info` must succeed; on failure die with: `systemctl
     status/restart docker`, the docker-group hint (`usermod -aG docker`), and
     the `SPECR_DATABASE_URL` escape hatch.
   - If `compose port postgres 5432` returns a mapping, the service is
     already running — reuse it and parse the live published host port from
     that same output. (Works on both compose v2 and legacy v1, unlike
     `ps --status=running`.)
   - Else choose a host port: start at `SPECR_PG_PORT`; while busy (bash
     `/dev/tcp` probe) bump +1 up to +20; exhausted → die. If the chosen port
     ≠ 5432, write `.specr-runtime/compose.port.yml` as a complete standalone
     copy of the postgres service publishing `<port>:5432`, and use it as the
     only `-f` file with `--project-directory <repo>` so the project name and
     `specr_pgdata` volume stay identical. (Compose merges `ports` lists by
     appending; the `!override` tag needs v2.24+, which would break the
     legacy-v1 support promised above.)
   - `compose up -d postgres` (its own progress output suffices; no custom
     meter). Probe readiness: loop `compose exec -T postgres pg_isready -U
     specr -q` every 1s, 30s deadline; timeout → print `compose logs --tail 40
     postgres` and die. Record `STARTED_PG=1`.
   - `DATABASE_URL=postgresql://specr:specr@localhost:<port>/specr` — user,
     password, and database all auto-created by the image's env on first run;
     no `createdb` step.
5. **App.** Die if `SPECR_PORT` is busy (remedy: close it or override). Export
   `DATABASE_URL`, `NODE_ENV=production`, `PORT=$SPECR_PORT`. Then, each fatal
   on non-zero exit: `pnpm install --frozen-lockfile`, `pnpm migrate`,
   `pnpm seed`, `pnpm build`. Print the green console banner (URL, drag-drop
   hint, Ctrl+C hint).
6. **Browser.** Background subshell: poll the app port (bash `/dev/tcp`,
   500 ms interval, 60 s deadline); on first answer, `xdg-open
   http://localhost:$PORT` — only when `xdg-open` exists and `DISPLAY` or
   `WAYLAND_DISPLAY` is set (headless boxes just print the URL).
7. **Run + cleanup.** `node dist/index.js` in the foreground; capture its exit
   code. An `EXIT` trap runs `compose stop postgres` (stop, not down — the
   container and `specr_pgdata` volume survive for fast re-runs) **only if
   `STARTED_PG=1`**, kills the browser-watcher if still pending, and the
   script exits with the server's code.

## Error Handling

Explicit checks at every external boundary; `set -Eeuo pipefail` is the
backstop, not the strategy. `die()` always prints cause + remedy. The
broken-daemon path (the current state of the dev machine) and the
port-collision path are first-class, tested behaviors — not incidental.

## Verification

No unit tests — repo precedent exempts bootstrap scripts (`scripts/` and the
ps1/bat pair carry none; TDD applies to `src/`). Instead:

1. `bash -n Start-SpecR.sh` (syntax) and `shellcheck Start-SpecR.sh` clean
   (install shellcheck if absent; if uninstallable, note it in the PR).
2. Manual matrix on the Manjaro dev box:
   - Docker daemon down → actionable error path fires (testable right now).
   - Daemon restored → full happy path: clone-fresh simulation by deleting
     `.specr-runtime/`, run, console opens, drag-drop works, Ctrl+C stops
     server and compose postgres.
   - Re-run → cached paths hit (no re-downloads, container reused).
   - `SPECR_PORT` collision → die with remedy.
3. `git check-attr text eol Start-SpecR.sh` → LF; `git ls-files -s
   Start-SpecR.sh` → mode 100755.

## File Changes

| File             | Change                                          |
| ---------------- | ----------------------------------------------- |
| `Start-SpecR.sh` | new — the bootstrap (~250–300 lines)            |
| `.gitattributes` | add `*.sh text eol=lf`                          |

Commit: `feat(scripts): one-shot Linux bootstrap (Start-SpecR.sh)` on
`mockup`.
