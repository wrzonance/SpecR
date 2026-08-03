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
 * `NODE_ENV` is `'test'`, never `'development'`: `development` arms the
 * configurable rate limiter (ADR-046) and produces false 429s.
 *
 * Both values are seeded **unconditionally**, overwriting anything ambient.
 * Deferring to an ambient value would mean a unit test that forgets to mock
 * its DB silently runs against whatever `DATABASE_URL` the developer or CI
 * job happens to export — a real database — instead of failing fast against
 * the unresolvable placeholder. The `unit` project is the no-DB suite by
 * definition, so there is no legitimate ambient value for it to inherit,
 * and inheriting `NODE_ENV=development` would re-arm the rate limiter this
 * placeholder exists to keep out. A test that needs a different value still
 * sets it in its own `beforeEach` — that runs long after this file.
 */
export const UNIT_TEST_DATABASE_URL_PLACEHOLDER =
  'postgres://unit-test:unit-test@unit-test-stub.invalid:5432/specr_unit_test_placeholder';

export const UNIT_TEST_NODE_ENV_PLACEHOLDER = 'test';

export function applyUnitTestEnvDefaults(): void {
  process.env['DATABASE_URL'] = UNIT_TEST_DATABASE_URL_PLACEHOLDER;
  process.env['NODE_ENV'] = UNIT_TEST_NODE_ENV_PLACEHOLDER;
}

applyUnitTestEnvDefaults();
