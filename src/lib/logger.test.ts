import { describe, it, expect, beforeAll } from 'vitest';

describe('logger', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['LOG_LEVEL'] = 'debug';
  });

  it('has info, error, debug, and warn methods', async () => {
    const { logger } = await import('./logger.js');

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('logger.level equals config.LOG_LEVEL', async () => {
    const { logger } = await import('./logger.js');
    const { config } = await import('./env.js');

    expect(logger.level).toBe(config.LOG_LEVEL);
  });

  it('closeLogger resolves as a no-op when logging to stdout (no transport worker)', async () => {
    // In the test env there is no file transport, so closeLogger must not try to
    // end/await a non-existent worker — it has to resolve immediately.
    const { closeLogger } = await import('./logger.js');
    await expect(closeLogger()).resolves.toBeUndefined();
  });
});

const base = {
  NODE_ENV: 'production' as const,
  LOG_LEVEL: 'info',
  LOG_DIR: 'logs',
  LOG_TO_FILE: false,
};

describe('buildLoggerOptions', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test';
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['LOG_LEVEL'] = 'debug';
  });

  it('prod, no file → plain pino (no transport worker), unchanged behaviour', async () => {
    const { buildLoggerOptions } = await import('./logger.js');
    const opts = buildLoggerOptions({ ...base } as never);
    expect(opts.transport).toBeUndefined();
    expect(opts.level).toBe('info');
  });

  it('dev → pino-pretty transport target', async () => {
    const { buildLoggerOptions } = await import('./logger.js');
    const opts = buildLoggerOptions({ ...base, NODE_ENV: 'development' } as never);
    const targets = (opts.transport as { targets: Array<{ target: string }> }).targets;
    expect(targets.some((t) => t.target === 'pino-pretty')).toBe(true);
  });

  it('LOG_TO_FILE → pino-roll file target + stdout in prod', async () => {
    const { buildLoggerOptions } = await import('./logger.js');
    const opts = buildLoggerOptions({ ...base, LOG_TO_FILE: true } as never);
    const targets = (
      opts.transport as { targets: Array<{ target: string; options: Record<string, unknown> }> }
    ).targets;
    expect(targets.some((t) => t.target === 'pino-roll')).toBe(true);
    expect(targets.some((t) => t.target === 'pino/file')).toBe(true); // stdout mirror
  });

  it('buildLoggerOptions: pino-roll target embeds .jsonl in file path (pino-roll@4 drops the extension option)', async () => {
    const { buildLoggerOptions } = await import('./logger.js');
    const opts = buildLoggerOptions({ ...base, LOG_TO_FILE: true } as never);
    const targets = (
      opts.transport as { targets: Array<{ target: string; options: Record<string, unknown> }> }
    ).targets;
    const rollTarget = targets.find((t) => t.target === 'pino-roll');
    expect(rollTarget).toBeDefined();
    // pino-roll@4.0.0 silently ignores the `extension` option (see logger.ts), so
    // the .jsonl extension MUST live in `file`. A "cleanup" that moves it back to a
    // separate `extension` key would regress output files to .log — this pins it.
    expect(String(rollTarget?.options.file)).toMatch(/\.jsonl$/);
  });
});
