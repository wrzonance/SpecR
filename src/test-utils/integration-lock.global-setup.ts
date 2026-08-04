import { Client } from 'pg';
import { config } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Serializes concurrent `pnpm test:integration` invocations against the same
 * `DATABASE_URL` (ADR-090, #638). `vitest.config.ts`'s `fileParallelism: false`
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
 * `src/db/index.ts` — because a session advisory lock is pinned to one
 * physical connection for its lifetime, and a `Pool` checks connections in
 * and out per query, which would silently release the lock between queries.
 */

// One fixed key for the whole repo: any two invocations pointed at the same
// DATABASE_URL must serialize regardless of which database that is, and
// invocations on different databases (the per-agent isolated-DB workflow)
// never contend with each other in the first place — Postgres advisory locks
// are scoped per-connection-to-a-database, so the shared key is safe. Plain
// JS number (not bigint): well within Number.MAX_SAFE_INTEGER, and pg's
// parameter serialization for `bigint` values is not something to depend on
// for a one-off constant — a plain integer round-trips through pg_advisory_lock's
// bigint parameter via Postgres's own untyped-parameter coercion.
const INTEGRATION_LOCK_KEY = 638_073;

export default async function setup(): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();

  const probe = await client.query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1)',
    [INTEGRATION_LOCK_KEY]
  );
  const acquiredImmediately = probe.rows[0]?.pg_try_advisory_lock ?? false;

  if (!acquiredImmediately) {
    logger.info(
      { lockKey: INTEGRATION_LOCK_KEY },
      'integration-lock: waiting on another pnpm test:integration invocation against this DATABASE_URL'
    );
    await client.query('SELECT pg_advisory_lock($1)', [INTEGRATION_LOCK_KEY]);
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
