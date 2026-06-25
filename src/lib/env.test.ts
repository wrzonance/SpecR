import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('env validation — defaults and coercion', () => {
  it('returns typed config with correct values when env is valid', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '4000';
    process.env['LOG_LEVEL'] = 'debug';

    const { config } = await import('./env.js');

    expect(config.DATABASE_URL).toBe('postgres://test:test@localhost:5432/test');
    expect(config.NODE_ENV).toBe('test');
    expect(config.PORT).toBe(4000);
    expect(typeof config.PORT).toBe('number');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.OCR_MIN_CHARS_PER_PAGE).toBe(16);
  });

  it('defaults PORT to 3000 when not set', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    delete process.env['PORT'];

    const { config } = await import('./env.js');

    expect(config.PORT).toBe(3000);
  });

  it('defaults LOG_LEVEL to info when not set', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    delete process.env['LOG_LEVEL'];

    const { config } = await import('./env.js');

    expect(config.LOG_LEVEL).toBe('info');
  });

  it('defaults OCR_MIN_CHARS_PER_PAGE to 16 when not set', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    delete process.env['OCR_MIN_CHARS_PER_PAGE'];

    const { config } = await import('./env.js');

    expect(config.OCR_MIN_CHARS_PER_PAGE).toBe(16);
  });

  it('coerces OCR_MIN_CHARS_PER_PAGE to a positive integer', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    process.env['OCR_MIN_CHARS_PER_PAGE'] = '24';

    const { config } = await import('./env.js');

    expect(config.OCR_MIN_CHARS_PER_PAGE).toBe(24);
  });

  it('coerces PORT string "4000" to number 4000', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';
    process.env['PORT'] = '4000';

    const { config } = await import('./env.js');

    expect(config.PORT).toBe(4000);
    expect(typeof config.PORT).toBe('number');
  });
});

describe('env validation — invalid env exits process', () => {
  it('exits with code 1 when DATABASE_URL is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    process.env['DATABASE_URL'] = '';
    process.env['NODE_ENV'] = 'test';

    await expect(import('./env.js')).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits with code 1 when NODE_ENV is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    delete process.env['NODE_ENV'];

    await expect(import('./env.js')).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
