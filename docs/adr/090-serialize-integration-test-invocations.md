# ADR-090: serialize concurrent integration-suite invocations with a session advisory lock

## Status

Accepted

## Context

`vitest.config.ts` sets `fileParallelism: false` on the `integration` project
(issue #73) so that test *files* never run concurrently against the shared
PostgreSQL instance **within one Vitest process**. That setting does nothing
across two separate `pnpm test:integration` *invocations* pointed at the same
`DATABASE_URL` — two Vitest processes, each internally serial, still race
against each other. Issue #638 (surfaced by the Codex `gpt-5.6-sol`
adversarial review on PR #629, declined there as out of scope) documented
three concrete collision shapes:

1. **Blanket teardown deletes the other run's rows.**
   `src/db/queries/libraries.integration.test.ts`'s `clearReservedNamespaces`
   deletes every non-built-in library and every `99 77 %` spec by pattern, not
   by the ids the current run created — a concurrent invocation's fixtures are
   indistinguishable from residue and get swept mid-run.
2. **Un-suffixed reserved literals collide on a unique key.** Two invocations
   both inserting section `99 77 01`/`99 77 02` against the shared built-in
   company library collide on `specs_section_source_library_unique` (pg
   23505). Renaming the literals to escape this is not viable —
   `src/lib/section-number.ts`'s `SECTION_NUMBER_RE` is a strict
   `^\d{2} \d{2} \d{2}(...)?$` grammar backed by the DB's own
   `specs_section_shape_check`, so an arbitrary per-run suffix on a section
   *value* would fail that CHECK constraint outright.
3. **Name-based cleanup can delete a live row mid-test.** Several suites sweep
   fixtures by a fixed name/pattern (`WHERE name = 'lib-xor-test-project'`,
   `WHERE section LIKE '99 00 0%'`) rather than by a captured id, so a
   concurrent invocation's row with the same name can be deleted between its
   creation and its dependent insert.

This is latent, not active: the project's own execution model gives each
parallel agent an isolated `DATABASE_URL` (`specr_iNNN` per worktree), so no
observed CI or agent failure has been attributed to it. But it is a real,
reachable property of the harness for any human or CI job that runs two
`pnpm test:integration` invocations against one database — e.g. a developer
running the suite locally while CI runs it against the same shared box, or a
second manual run kicked off before the first finishes.

## Decision

**Serialize whole invocations** with a PostgreSQL **session-level advisory
lock** (`pg_advisory_lock`), held for the run's full lifetime on one dedicated
`pg.Client`, acquired in a Vitest `globalSetup` scoped to the `integration`
project and released in that hook's teardown closure.

Mechanism (`src/test-utils/integration-lock.global-setup.ts`):

- Opens one dedicated `pg.Client` — never the shared `pool`/`createPool()`
  from `src/db/index.ts` — because a session advisory lock belongs to the one
  backend session that acquired it, and a `Pool` checks connections in and out
  per query. A pool does not drop the lock early; it strands it. The acquiring
  connection returns to the pool still holding the lock, and the later
  `pg_advisory_unlock` most likely runs on a different backend, where it is a
  no-op that returns false — leaving the lock held by an idle pooled session
  and blocking every subsequent invocation until the pool closes it.
- Probes non-blocking first (`pg_try_advisory_lock`). If another invocation
  already holds it, logs **once** via the pino logger (`src/lib/logger.js`)
  that this run is waiting on another `pnpm test:integration` invocation,
  then falls back to the blocking `pg_advisory_lock`.
- Returns a teardown closure that best-effort `pg_advisory_unlock`s, then
  unconditionally `client.end()`s in a `finally` — teardown must never throw
  past itself.
- The lock key is one fixed, stable constant for the whole process/repo (not
  derived per-`DATABASE_URL`), so any two invocations pointed at the *same*
  database serialize, and invocations on different databases never contend.

We additionally hardened four sibling integration suites whose teardown was
genuinely name/pattern-based rather than id-scoped and whose exact symptom
the issue named (`libraries`, `editability` (db + api), `reclassify`) as
defense-in-depth — a few id-scoped `DELETE`s or a `try/finally` were
straightforward to add, and relying on a single mechanism for an entire class
of data loss is a worse trade than that small extra cost.

A repo-wide grep sweep (`grep -rn "DELETE FROM.*LIKE\|DELETE FROM.*NOT IN\|WHERE name ="`
across every `*.integration.test.ts`) found the same
reserved-namespace-plus-blanket-delete idiom in roughly thirty more suites —
`DELETE FROM ... WHERE name LIKE 'some-prefix-%'` on projects, libraries,
clients, and users. We deliberately did **not** rewrite all of them to
id-scoped deletes. The lock is the structural fix for every one of them, not
just the four hardened above: none of these blanket sweeps can touch another
invocation's rows once at most one invocation is ever live against a given
database. Rewriting ~30 already-well-tested files to duplicate protection the
lock already provides would be a large, regression-risky diff for zero
additional correctness under acceptance criterion 2 (which only requires
concurrent invocations to "either both pass or are deterministically
serialized," not that every suite also be independently concurrency-safe).
This is a deliberate proportionality call, not a deferral — see the PR body
for the full file list this sweep considered.

### Rejected: per-invocation database or schema isolation

The alternative from the issue — give each invocation its own database or
`search_path`-scoped schema — was rejected:

- **Migration + seed cost per invocation.** Every run would need to
  `migrate → seed` a fresh target before testing, adding real wall-clock cost
  to what is currently a single `pnpm test:integration` call against an
  already-prepared database. The lock adds none: acquiring/releasing an
  advisory lock is a single round-trip, not a schema build.
- **Redundant with the per-agent workflow this project already runs.** The
  parallel-agent execution model already isolates concurrent work at the
  database level (one `specr_iNNN` per worktree) — a coarser, cheaper version
  of the same idea, chosen deliberately for the same reason (sidestep
  contention entirely rather than serialize it). Building schema-level
  isolation into the test harness itself would duplicate that mechanism
  without replacing it, since the issue explicitly keeps the per-agent
  workflow out of scope to change.
- **`search_path` hardcodes risk.** A non-trivial amount of the codebase
  (migrations, seed scripts, raw SQL in query modules) assumes the `public`
  schema implicitly. Auditing and parameterizing every one of those call
  sites to be schema-agnostic is a much larger, riskier change than a lock,
  for a benefit (true concurrency) nobody asked for — the acceptance
  criteria only require that concurrent invocations "either both pass or are
  deterministically serialized," not that they run in parallel.

### Developer ergonomics

A second `pnpm test:integration` invocation against a database another
invocation is already using does not hang silently — it blocks and the wait
is logged exactly once via the pino logger, so a developer watching the
second run's output sees why it hasn't started rather than assuming it is
stuck. Once the first invocation's teardown releases the lock, the second
proceeds immediately (measured in the spike: same-millisecond handoff between
one run's logged unlock and the next's first test starting).

## Consequences

- Two `pnpm test:integration` invocations against the same `DATABASE_URL` are
  now safe: they deterministically serialize instead of racing. Neither
  cross-run fixture deletion nor a `99 77 %`/23505 collision is reachable
  under the lock, because at most one invocation ever touches a given
  database at a time.
- CI cost is effectively unchanged — CI already runs a single integration
  invocation per job; the lock only matters when a second invocation targets
  the same database concurrently, which the advisory-lock acquire/probe adds
  negligible overhead to (`SELECT pg_try_advisory_lock($1)` is one query).
- The per-agent isolated-database workflow is untouched and unaffected: lock
  contention is scoped per `DATABASE_URL`, and agents already run against
  distinct databases, so they never see each other's lock.
- Postgres releases a session-level advisory lock automatically when the
  holding connection drops (verified in the spike via `kill -9` on the
  holding process, confirmed the next waiter re-acquired in ~0.06s) — a
  SIGKILLed or crashed test run cannot permanently wedge the next invocation.
- A worse failure mode this ADR explicitly avoids: relying on the lock alone
  without also hardening the four genuinely unsafe teardown sites would leave
  a silent single point of failure — if the lock were ever bypassed or
  misconfigured (e.g. a future change targets a different `DATABASE_URL`
  believing it to be isolated when it is not), the four hardened suites still
  fail closed on a captured-id basis instead of deleting a stranger's rows.
- `vitest.config.ts`'s `fileParallelism: false` comment on the `integration`
  project is updated to state explicitly that it scopes to files within one
  invocation only, and to point at this ADR for cross-invocation safety.
