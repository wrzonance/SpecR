import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// NOTE: `./unit-env-setup.js` is deliberately NOT imported statically here.
// That module seeds the env as an import-time side effect, and ESM evaluates a
// static import before this file's own top-level code — which would seed the
// placeholders itself and make ENV_AT_IMPORT below true no matter what the
// runner did. Every reference to it is a dynamic import inside a test body,
// which runs strictly after the capture.

// Captured at module scope, before any beforeEach can touch process.env, so it
// reflects what the Vitest *runner* handed this worker — i.e. the result of the
// `setupFiles` hook, not of anything this file does.
const ENV_AT_IMPORT = {
  DATABASE_URL: process.env['DATABASE_URL'],
  NODE_ENV: process.env['NODE_ENV'],
};

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

// The wiring, not the helper. Every other test here calls
// applyUnitTestEnvDefaults() by hand, so they all stay green if the
// `setupFiles` entry is deleted from vitest.config.ts — which is precisely the
// regression #472 is about. These assertions read the env the runner produced,
// so they fail if that entry goes missing.
describe('unit-env-setup: registered as the unit project setupFiles hook', () => {
  it('the runner seeded the placeholders before this file was imported', async () => {
    const { UNIT_TEST_DATABASE_URL_PLACEHOLDER, UNIT_TEST_NODE_ENV_PLACEHOLDER } =
      await import('./unit-env-setup.js');

    expect(ENV_AT_IMPORT.DATABASE_URL).toBe(UNIT_TEST_DATABASE_URL_PLACEHOLDER);
    expect(ENV_AT_IMPORT.NODE_ENV).toBe(UNIT_TEST_NODE_ENV_PLACEHOLDER);
  });
});

describe('unit-env-setup: applyUnitTestEnvDefaults', () => {
  it('overwrites an ambient DATABASE_URL/NODE_ENV rather than deferring to it', async () => {
    // An ambient value is exactly the hazard: deferring to it would point an
    // unmocked unit test at a developer's or CI's real database, and would let
    // NODE_ENV=development through to arm the rate limiter (ADR-046).
    process.env['DATABASE_URL'] = 'postgres://real:real@localhost:5432/real';
    process.env['NODE_ENV'] = 'development';

    const {
      applyUnitTestEnvDefaults,
      UNIT_TEST_DATABASE_URL_PLACEHOLDER,
      UNIT_TEST_NODE_ENV_PLACEHOLDER,
    } = await import('./unit-env-setup.js');
    applyUnitTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBe(UNIT_TEST_DATABASE_URL_PLACEHOLDER);
    expect(process.env['NODE_ENV']).toBe(UNIT_TEST_NODE_ENV_PLACEHOLDER);
  });

  it('seeds the placeholders when nothing is set at all', async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['NODE_ENV'];

    const {
      applyUnitTestEnvDefaults,
      UNIT_TEST_DATABASE_URL_PLACEHOLDER,
      UNIT_TEST_NODE_ENV_PLACEHOLDER,
    } = await import('./unit-env-setup.js');
    applyUnitTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBe(UNIT_TEST_DATABASE_URL_PLACEHOLDER);
    expect(process.env['NODE_ENV']).toBe(UNIT_TEST_NODE_ENV_PLACEHOLDER);
  });

  it('seeds a non-resolvable .invalid-TLD DATABASE_URL placeholder', async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['NODE_ENV'];

    const { applyUnitTestEnvDefaults } = await import('./unit-env-setup.js');
    applyUnitTestEnvDefaults();

    // RFC 2606 reserves .invalid as guaranteed-non-resolvable, so a test that
    // forgets to mock the DB fails fast on DNS resolution instead of hanging
    // on (or worse, silently succeeding against) a real local Postgres.
    expect(process.env['DATABASE_URL']).toMatch(/\.invalid[:/]/);
  });
});

describe('unit suite regression (#472): process.exit no longer fires when DATABASE_URL/NODE_ENV are unset', () => {
  it.each([
    ['../db/queries/open-comments.js'],
    ['../db/queries/language-rule-findings.js'],
    ['../mcp/handlers.js'],
    ['../api/router.js'],
  ])('%s imports cleanly with env unset', async (specifier) => {
    delete process.env['DATABASE_URL'];
    delete process.env['NODE_ENV'];

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called — env.ts import-time validation failed');
    });

    // Restored in `finally`: on a failing import or assertion an early return
    // would leak the stubbed process.exit into every later case in this
    // worker, masking the very exit path these tests exist to detect.
    try {
      // Replicate what the real setupFiles hook does: seed the env before any
      // module under test is imported, inside this controlled, cleared context.
      const { applyUnitTestEnvDefaults } = await import('./unit-env-setup.js');
      applyUnitTestEnvDefaults();

      await expect(import(specifier)).resolves.toBeDefined();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
