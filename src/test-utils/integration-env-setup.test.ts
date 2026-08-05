import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// See unit-env-setup.test.ts for why `./integration-env-setup.js` is never
// statically imported here: it seeds process.env as an import-time side
// effect, and a static import would run before this file's own top-level
// code, making any "what did the runner hand us" capture meaningless.

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('integration-env-setup: applyIntegrationTestEnvDefaults', () => {
  it('overwrites an ambient NODE_ENV=development rather than deferring to it', async () => {
    // The exact hazard #442 fixes: a developer's shell (or a manually
    // sourced .env, as dev/migrate/seed already do) commonly exports
    // NODE_ENV=development, which would re-arm the rate limiter (ADR-046)
    // and produce false 429s partway through `pnpm test:integration`.
    process.env['NODE_ENV'] = 'development';

    const { applyIntegrationTestEnvDefaults, INTEGRATION_TEST_NODE_ENV_PLACEHOLDER } =
      await import('./integration-env-setup.js');
    applyIntegrationTestEnvDefaults();

    expect(process.env['NODE_ENV']).toBe(INTEGRATION_TEST_NODE_ENV_PLACEHOLDER);
  });

  it('seeds NODE_ENV=test when nothing is set at all', async () => {
    delete process.env['NODE_ENV'];

    const { applyIntegrationTestEnvDefaults, INTEGRATION_TEST_NODE_ENV_PLACEHOLDER } =
      await import('./integration-env-setup.js');
    applyIntegrationTestEnvDefaults();

    expect(process.env['NODE_ENV']).toBe(INTEGRATION_TEST_NODE_ENV_PLACEHOLDER);
  });

  // The defining difference from unit-env-setup.ts: the integration project
  // runs against a REAL PostgreSQL instance, so this helper must never touch
  // DATABASE_URL — doing so would either break every integration test (by
  // pointing it at a non-resolvable placeholder) or silently redirect it to
  // some other database.
  it('never touches DATABASE_URL', async () => {
    process.env['DATABASE_URL'] = 'postgres://real:real@localhost:5432/real_integration_db';

    const { applyIntegrationTestEnvDefaults } = await import('./integration-env-setup.js');
    applyIntegrationTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBe(
      'postgres://real:real@localhost:5432/real_integration_db'
    );
  });

  it('leaves DATABASE_URL unset when it was never set', async () => {
    delete process.env['DATABASE_URL'];

    const { applyIntegrationTestEnvDefaults } = await import('./integration-env-setup.js');
    applyIntegrationTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBeUndefined();
  });
});
