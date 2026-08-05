/**
 * Test-only helper (#442): mirrors `unit-env-setup.ts`, but scoped to the
 * `integration` Vitest project — which, unlike `unit`, runs against a real
 * PostgreSQL instance (`DATABASE_URL` from `.env` / the shell / CI secrets).
 * This helper must therefore never touch `DATABASE_URL`; it forces only
 * `NODE_ENV`.
 *
 * `src/lib/env.ts` validates `NODE_ENV` at *import time*, and
 * `src/api/router.ts`'s rate limiter is skipped only when
 * `config.NODE_ENV === 'test'` (ADR-046). A developer's shell (or a
 * `.env` sourced by hand, as `dev`/`migrate`/`seed` already do — see
 * CLAUDE.md) commonly exports `NODE_ENV=development` for everyday work.
 * Without this helper, that ambient value leaks into `pnpm test:integration`
 * and re-arms the rate limiter, producing false 429s partway through a run.
 *
 * Registered as the `integration` project's `setupFiles` entry
 * (vitest.config.ts), this runs before any test file's own imports are
 * evaluated, forcing `NODE_ENV=test` unconditionally — overwriting any
 * ambient value — so `pnpm test:integration` behaves identically regardless
 * of what the invoking shell happened to export.
 *
 * This is defense-in-depth only: it changes no production behavior. Outside
 * the test runner, `config.NODE_ENV` is still whatever `.env`/the real
 * environment sets, and the rate limiter still applies in `development`/
 * `production` exactly as ADR-046 specifies.
 */
export const INTEGRATION_TEST_NODE_ENV_PLACEHOLDER = 'test';

export function applyIntegrationTestEnvDefaults(): void {
  process.env['NODE_ENV'] = INTEGRATION_TEST_NODE_ENV_PLACEHOLDER;
}

applyIntegrationTestEnvDefaults();
