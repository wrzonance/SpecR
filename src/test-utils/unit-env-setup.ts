/**
 * Test-only helper (#472): the `unit` Vitest project runs with no PostgreSQL
 * instance, but `src/lib/env.ts` validates `DATABASE_URL`/`NODE_ENV` at
 * *import time* and calls `process.exit(1)` on failure — so any unit test
 * whose import chain reaches env.ts (directly, or via a DB query module or
 * an MCP handler barrel) crashes the whole file unless those two vars are
 * already set in the shell.
 *
 * Registered as the `unit` project's `setupFiles` entry (vitest.config.ts),
 * this runs before any test file's own imports are evaluated, seeding
 * non-secret placeholders so `pnpm test` passes standalone with no ambient
 * env and no real Postgres.
 *
 * `DATABASE_URL` uses an RFC 2606 `.invalid`-TLD host — guaranteed
 * non-resolvable (DNS failure), not merely a bad-but-routable address —
 * so a future unit test that forgets to mock the DB and issues a real query
 * fails fast and loud instead of hanging on (or silently succeeding
 * against) a developer's real local Postgres on :5432.
 *
 * `NODE_ENV` is `'test'`, never `'development'`: per project memory,
 * `NODE_ENV=development` arms the rate limiter and produces false 429s.
 *
 * Never clobbers an already-set value — a real ambient value (CI,
 * docker-compose, or a test's own beforeEach override) always wins.
 */
export const UNIT_TEST_DATABASE_URL_PLACEHOLDER =
  'postgres://unit-test:unit-test@unit-test-stub.invalid:5432/specr_unit_test_placeholder';

export const UNIT_TEST_NODE_ENV_PLACEHOLDER = 'test';

export function applyUnitTestEnvDefaults(): void {
  if (!process.env['DATABASE_URL']) {
    process.env['DATABASE_URL'] = UNIT_TEST_DATABASE_URL_PLACEHOLDER;
  }
  if (!process.env['NODE_ENV']) {
    process.env['NODE_ENV'] = UNIT_TEST_NODE_ENV_PLACEHOLDER;
  }
}

applyUnitTestEnvDefaults();
