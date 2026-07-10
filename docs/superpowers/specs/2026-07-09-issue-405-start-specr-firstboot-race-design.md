# Design — #405: Start-SpecR.sh first-boot race (TCP wait vs initdb restart)

**Status:** Approved (brainstorm 2026-07-09)
**Issue:** #405 (bug)
**Module:** `examples/web_ui_demo/Start-SpecR.sh`

## Root cause

`initialize_docker_database()` (Start-SpecR.sh ~169–176) gates readiness on
`tcp_is_open localhost "$port"`. docker-proxy binds the published host port the instant the
container starts — **before** postgres inside is accepting SQL. On a fresh `specr_pgdata`
volume, the postgres image runs its initdb sequence (a temporary server bound to the unix
socket with `listen_addresses=''`, then shutdown, then the real server). The TCP gate passes
during that window, so `pnpm migrate` connects to the transient state and dies:

```
could not connect to postgres: Error: Connection terminated unexpectedly
```

A second run succeeds (volume already initialized). Reproduced 2026-07-07 via
`docker compose down -v` → run → exit 1 → rerun → success.

## Fix — protocol-aware readiness

Keep the fast TCP gate (cheap, and the only option for an externally-supplied DB), then add a
**protocol-aware** confirmation **only when the script started the bundled postgres itself**:

1. TCP opens on the chosen host port (existing check) — necessary but not sufficient.
2. Then loop `docker compose exec -T postgres pg_isready -U specr -d specr -q` until it
   returns 0, bounded by the existing ~60s budget. Require **2 consecutive** successes with a
   short sleep between, to close the initdb temp-server → real-server window (a single
   success can still land on the transient server).
3. Only then set `DOCKER_DATABASE_PORT` and return success.

Externally-supplied `DATABASE_URL` (`DATABASE_URL_WAS_SUPPLIED=1`) keeps the TCP-only gate —
the script can't `docker compose exec` into a DB it didn't start. (Optional nicety: a one-shot
`pg_isready`/`psql -c 'select 1'` against it *if* a client is on PATH — not required.)

## Invariants (tests)

1. Fresh-volume single run: `docker compose down -v` → one `Start-SpecR.sh` run reaches
   `pnpm migrate` without "Connection terminated unexpectedly".
2. Reused-volume run: unchanged fast path (no extra latency beyond the pg_isready confirm).
3. External `DATABASE_URL`: behavior unchanged (no `docker compose exec` attempted).

## Testing

- Extend the existing **start-specr shell regression test** (the harness #398 updated) to cover
  the new gate: assert the readiness function does not return until `pg_isready` succeeds
  (mock/stub `docker compose exec` to fail-then-succeed and confirm the loop waits).
- Manual verification (record in PR): `docker compose down -v` → single run succeeds.
- Keep the code comment block explaining *why* TCP-open ≠ ready (the docker-proxy + initdb race).

## Deliverables

- Protocol-aware gate in `initialize_docker_database()` (bundled-postgres branch only).
- Regression test extension.
- Comment documenting the race.
