import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('unit-env-setup: applyUnitTestEnvDefaults', () => {
  it('fills DATABASE_URL/NODE_ENV only when unset, never clobbers an existing value', async () => {
    delete process.env['DATABASE_URL'];
    delete process.env['NODE_ENV'];

    const { applyUnitTestEnvDefaults } = await import('./unit-env-setup.js');
    applyUnitTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBeTruthy();
    expect(process.env['NODE_ENV']).toBe('test');

    // A second invocation, with a caller-set value already present, must not
    // clobber it — this is what protects a real ambient CI/docker-compose
    // value or a test's own beforeEach override.
    process.env['DATABASE_URL'] = 'postgres://real:real@localhost:5432/real';
    process.env['NODE_ENV'] = 'production';
    applyUnitTestEnvDefaults();

    expect(process.env['DATABASE_URL']).toBe('postgres://real:real@localhost:5432/real');
    expect(process.env['NODE_ENV']).toBe('production');
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

    // Replicate what the real setupFiles hook does: seed the env before any
    // module under test is imported, inside this controlled, cleared context.
    const { applyUnitTestEnvDefaults } = await import('./unit-env-setup.js');
    applyUnitTestEnvDefaults();

    await expect(import(specifier)).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });
});
