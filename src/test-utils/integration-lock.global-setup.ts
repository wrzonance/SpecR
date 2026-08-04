import { Client } from 'pg';
import { DatabaseError } from '../db/errors.js';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Serializes concurrent `pnpm test:integration` invocations against the same
 * PostgreSQL database (ADR-090, #638). Scope is the DATABASE, not the
 * connection string: an advisory lock's tag includes the database OID, so two
 * different `DATABASE_URL`s pointing at one database still contend, and the
 * same key in two different databases does not. `vitest.config.ts`'s `fileParallelism: false`
 * only serializes test *files* within a single Vitest process — two separate
 * invocations still race on the shared database (blanket teardown deleting a
 * concurrent run's fixtures, unique-key collisions on reserved section
 * literals, name-based cleanup deleting a live row mid-test). A session-level
 * PostgreSQL advisory lock, held for the whole run, makes at most one
 * invocation touch a given database at a time.
 *
 * Registered as the `integration` project's `globalSetup` in
 * `vitest.config.ts`. Vitest runs `globalSetup` exactly once per project per
 * invocation, before any test file's own imports are evaluated, and blocks
 * test collection until the returned promise resolves — so the lock is held
 * before any suite can touch the database.
 *
 * A dedicated `pg.Client` — never the shared `pool`/`createPool()` from
 * `src/db/index.ts` — because a session advisory lock belongs to the one
 * backend session that took it, and a `Pool` checks connections in and out
 * per query. The failure a pool causes is not an early release but the
 * opposite: the lock stays held by whichever backend ran the acquire, that
 * connection goes back to the pool idle, and a later
 * `pg_advisory_unlock` is likely to run on a DIFFERENT backend — where it is
 * a no-op returning false. The lock is then stranded on an idle pooled
 * session until the pool closes it, and every subsequent invocation blocks.
 */

// One fixed key for the whole repo: any two invocations pointed at the same
// database must serialize regardless of how they were addressed, and
// invocations on different databases (the per-agent isolated-DB workflow)
// never contend with each other in the first place — a Postgres advisory
// lock's tag includes the database OID, so the shared key is safe (and two
// different DATABASE_URLs resolving to ONE database still serialize). Plain
// JS number (not bigint): well within Number.MAX_SAFE_INTEGER, and pg's
// parameter serialization for `bigint` values is not something to depend on
// for a one-off constant — a plain integer round-trips through pg_advisory_lock's
// bigint parameter via Postgres's own untyped-parameter coercion.
const INTEGRATION_LOCK_KEY = 638_073;

/**
 * Probes non-blocking first, and only falls back to the blocking acquire when
 * another invocation already holds the lock — so the "this run is waiting" log
 * fires exactly once, and only when it is true.
 *
 * Once `connect()` has succeeded the caller owns an open socket that Vitest can
 * only close through the teardown closure `setup` returns at the end. Every
 * failure before that return must therefore close the client here — otherwise a
 * rejected acquire (e.g. a `statement_timeout` shorter than the holding run,
 * which cancels the blocking `pg_advisory_lock`) throws out of `globalSetup`
 * leaving a live connection behind and the event loop alive on the way out.
 * The original error is rethrown unchanged; the cleanup is best-effort and
 * never masks it.
 */
async function acquireOrClose(client: Client): Promise<void> {
  try {
    const probe = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1)',
      [INTEGRATION_LOCK_KEY]
    );
    if (probe.rows[0]?.pg_try_advisory_lock ?? false) return;

    logger.info(
      { lockKey: INTEGRATION_LOCK_KEY },
      'integration-lock: waiting on another pnpm test:integration invocation against this database'
    );
    await client.query('SELECT pg_advisory_lock($1)', [INTEGRATION_LOCK_KEY]);
  } catch (err) {
    try {
      await client.end();
    } catch (endErr) {
      logger.error(
        { err: endErr },
        'integration-lock: client.end() failed while cleaning up a failed lock acquisition'
      );
    }
    throw err;
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: config.DATABASE_URL });
  // Module boundary: `globalSetup` is the surface Vitest calls, so a raw `pg`
  // error must not escape it untyped (CLAUDE.md). `acquireOrClose` has already
  // closed the client on its own failure path; this only re-labels the error,
  // chaining the original as `cause` so the why-chain survives to the console.
  try {
    await client.connect();
    await acquireOrClose(client);
  } catch (err) {
    throw new DatabaseError('could not acquire the integration-test advisory lock', { cause: err });
  }

  return async function teardown(): Promise<void> {
    // Best-effort unlock: a failure here (e.g. the connection already
    // dropped) must never propagate past teardown (ADR-090) — the process is
    // exiting either way, and a dropped session-scoped advisory lock is
    // released by Postgres automatically when its owning connection closes.
    try {
      const result = await client.query<{ pg_advisory_unlock: boolean }>(
        'SELECT pg_advisory_unlock($1)',
        [INTEGRATION_LOCK_KEY]
      );
      logger.info(
        { unlocked: result.rows[0]?.pg_advisory_unlock ?? false },
        'integration-lock: released'
      );
    } catch (err) {
      logger.error(
        { err },
        'integration-lock: pg_advisory_unlock query failed; the lock is released implicitly when the connection below closes'
      );
    } finally {
      // Unconditional, and itself never allowed to throw past this function
      // — the same invariant applies to closing the connection as to the
      // unlock query above.
      try {
        await client.end();
      } catch (err) {
        logger.error({ err }, 'integration-lock: client.end() failed during teardown');
      }
    }
  };
}
