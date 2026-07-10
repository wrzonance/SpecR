# Start-SpecR.sh Protocol-Aware Postgres Readiness — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Execute task-by-task; keep the build green between steps.

**Goal:** Fix the first-boot readiness race in `examples/web_ui_demo/Start-SpecR.sh` where the TCP gate passes before postgres finishes initdb, killing `pnpm migrate` with "Connection terminated unexpectedly".

**Architecture:** Keep the fast TCP gate, then — only on the bundled-postgres path the script started itself — confirm the SQL protocol is actually up via `docker compose exec -T postgres pg_isready`, requiring 2 consecutive successes. Add a `source`-guard so the script's functions can be unit-tested in isolation.

**Tech Stack:** Bash (POSIX-bash, matching the existing script style), Vitest (`src/start-specr-shell.test.ts`), Node.

## Global Constraints

- File: `examples/web_ui_demo/Start-SpecR.sh` — match existing style (`printf`, `local`, `$(seq …)` loops, `[[ ]]`, `((…))`).
- Preserve every string the existing regression test asserts (find_free_port line, `docker compose up -d --force-recreate postgres`, `SPECR_DB_HOST_PORT="$port"`, `docker compose version`, the `DATABASE_URL=` bundled line).
- External `DATABASE_URL` (`DATABASE_URL_WAS_SUPPLIED=1`) path must NOT invoke `docker compose exec` — no change to that branch (design supersedes the issue's optional migrate-retry idea).
- Commit scope `example`; conventional commits; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Bounded ~60s budget; test the loop fast by parameterizing attempts + stubbing `sleep`.

---

### Task 1: Source-guard seam + protocol-aware readiness function + wiring

**Files:**
- Modify: `examples/web_ui_demo/Start-SpecR.sh`
- Test: `src/start-specr-shell.test.ts`

**Interfaces:**
- Produces: `confirm_compose_postgres_ready [attempts]` — loops `docker compose exec -T postgres pg_isready -U specr -d specr -q`; returns 0 after 2 consecutive successes, 1 after `attempts` (default 60) tries. `sleep 1` between attempts.
- Produces: source-guard `if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then return 0; fi` after all function defs, before the top-level execution block — lets tests `source` the script to exercise functions without running main.

- [ ] **Step 1: Write failing behavioral tests** in `src/start-specr-shell.test.ts` driving a bash harness that sources the script and calls the function: (a) fail,fail,succeed,succeed pattern → returns READY after exactly 4 probes (proves it waits through failures AND needs 2 consecutive); (b) always-fail with attempts=5 → TIMEOUT after 5 probes; (c) succeed,fail,succeed,succeed → READY after 4 probes (proves streak resets on a gap); (d) external DATABASE_URL reachable → `initialize_database` returns 0 and never calls `docker compose exec`.
- [ ] **Step 2: Run tests → verify RED** (`pnpm test -- start-specr-shell`) — fails because `confirm_compose_postgres_ready` is undefined / source-guard absent (sourcing runs main).
- [ ] **Step 3: Implement** the source-guard, the `confirm_compose_postgres_ready` function, and rewire the wait loop in `initialize_docker_database` to gate on TCP then confirm; keep the WHY comment about docker-proxy + initdb.
- [ ] **Step 4: Run tests → verify GREEN**, including the existing 3 static tests still pass.
- [ ] **Step 5: `pnpm lint` + full `pnpm test` green.**
- [ ] **Step 6: Commit** `fix(example): protocol-aware postgres readiness gate in Start-SpecR.sh` (+ test in same or paired commit).
