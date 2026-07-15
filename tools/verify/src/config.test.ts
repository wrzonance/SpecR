import { describe, expect, it } from 'vitest';
import { loadVerifyEnv } from './config.js';
import { VerifyValidationError, toRunError } from './errors.js';

const validEnv = {
  SPECR_API_BASE_URL: 'http://localhost:3000',
  VERIFY_VIEWPORT_WIDTH: '900',
};

describe('loadVerifyEnv', () => {
  it('loads a valid env into camelCase VerifyEnv fields', () => {
    expect(loadVerifyEnv(validEnv)).toEqual({
      specrApiBaseUrl: 'http://localhost:3000',
      viewportWidth: 900,
    });
  });

  it('defaults viewportWidth to 900 when VERIFY_VIEWPORT_WIDTH is unset', () => {
    const env = { SPECR_API_BASE_URL: 'http://localhost:3000' };

    expect(loadVerifyEnv(env).viewportWidth).toBe(900);
  });

  it('ignores unrelated keys already present on process.env (PATH, HOME, ...)', () => {
    const env = { ...validEnv, PATH: '/usr/bin', HOME: '/home/whoever', RANDOM_UNRELATED: 'x' };

    expect(loadVerifyEnv(env)).toEqual({
      specrApiBaseUrl: 'http://localhost:3000',
      viewportWidth: 900,
    });
  });

  it('throws VerifyValidationError (stage: config) when SPECR_API_BASE_URL is missing', () => {
    expect(() => loadVerifyEnv({})).toThrow(VerifyValidationError);
    try {
      loadVerifyEnv({});
      expect.unreachable('loadVerifyEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyValidationError);
      expect((error as VerifyValidationError).stage).toBe('config');
      expect((error as VerifyValidationError).cause).toBeDefined();
    }
  });

  it('throws VerifyValidationError when SPECR_API_BASE_URL is not a valid URL', () => {
    const env = { ...validEnv, SPECR_API_BASE_URL: 'not-a-url' };

    expect(() => loadVerifyEnv(env)).toThrow(VerifyValidationError);
  });

  it('throws VerifyValidationError when VERIFY_VIEWPORT_WIDTH is not numeric', () => {
    const env = { ...validEnv, VERIFY_VIEWPORT_WIDTH: 'not-a-number' };

    expect(() => loadVerifyEnv(env)).toThrow(VerifyValidationError);
  });

  it('throws VerifyValidationError when VERIFY_VIEWPORT_WIDTH is zero or negative', () => {
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_VIEWPORT_WIDTH: '0' })).toThrow(
      VerifyValidationError
    );
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_VIEWPORT_WIDTH: '-900' })).toThrow(
      VerifyValidationError
    );
  });

  it('a config failure converts into a serializable RunError carrying stage, message, and cause', () => {
    let thrown: unknown;
    try {
      loadVerifyEnv({});
    } catch (error) {
      thrown = error;
    }

    const runError = toRunError('config', thrown);

    expect(runError.stage).toBe('config');
    expect(runError.message).toBe('invalid tools/verify environment configuration');
    expect(runError.cause).toBeDefined();
    expect(JSON.parse(JSON.stringify(runError))).toEqual(runError);
  });
});
