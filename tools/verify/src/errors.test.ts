import { describe, expect, it } from 'vitest';
import {
  RUN_STAGES,
  VerifyApiError,
  VerifyError,
  VerifyRenderError,
  VerifyValidationError,
  toRunError,
} from './errors.js';

// Pins the core invariant of the WT-150 error hierarchy: every pipeline
// stage failure and every HTTP handler failure converts to a serializable
// RunError carrying exactly { stage, message, cause? } — never a bare
// string, and never a raw stack trace leaking across the boundary.
describe('toRunError (serializable failure boundary)', () => {
  it('carries the origin VerifyError stage, message, and no cause when none was given', () => {
    const error = new VerifyRenderError('screenshot capture returned a blank canvas', {
      stage: 'screenshot',
    });

    const runError = toRunError('report', error);

    expect(runError).toEqual({
      stage: 'screenshot',
      message: 'screenshot capture returned a blank canvas',
    });
    expect(runError.cause).toBeUndefined();
  });

  it("prefers the VerifyError's own stage over the caller-supplied fallback stage", () => {
    const error = new VerifyApiError('upload rejected: 400 uploadMimeError', { stage: 'upload' });

    const runError = toRunError('diff', error);

    expect(runError.stage).toBe('upload');
  });

  it('chains an Error cause down to its message string', () => {
    const cause = new Error('ECONNREFUSED 127.0.0.1:3000');
    const error = new VerifyApiError('failed to reach SpecR API', { stage: 'upload', cause });

    const runError = toRunError('upload', error);

    expect(runError).toEqual({
      stage: 'upload',
      message: 'failed to reach SpecR API',
      cause: 'ECONNREFUSED 127.0.0.1:3000',
    });
  });

  it('falls back to the caller-supplied stage for a plain Error that escaped unwrapped', () => {
    const error = new Error('unexpected fetch failure');

    const runError = toRunError('parse', error);

    expect(runError).toEqual({ stage: 'parse', message: 'unexpected fetch failure' });
  });

  it('converts a non-Error thrown value to its string form with no cause', () => {
    const runError = toRunError('render', 'harness page crashed');

    expect(runError).toEqual({ stage: 'render', message: 'harness page crashed' });
  });

  it('never leaks a stack trace across the serialization boundary', () => {
    const error = new VerifyValidationError('invalid VERIFY_VIEWPORT_WIDTH', { stage: 'config' });

    const runError = toRunError('config', error);

    expect(Object.keys(runError).sort((a, b) => a.localeCompare(b))).toEqual(['message', 'stage']);
    expect(JSON.stringify(runError)).not.toContain('.ts:');
  });

  it('round-trips through JSON without losing or adding fields', () => {
    const error = new VerifyApiError('template import failed', {
      stage: 'import',
      cause: new Error('409 templateNameConflict'),
    });

    const runError = toRunError('import', error);
    const roundTripped = JSON.parse(JSON.stringify(runError)) as unknown;

    expect(roundTripped).toEqual(runError);
  });

  it.each(RUN_STAGES)('accepts %s as a valid RunStage on VerifyError', (stage) => {
    const error = new VerifyError('boundary check', { stage });
    expect(toRunError(stage, error).stage).toBe(stage);
  });
});

describe('VerifyError subclass identity', () => {
  it('sets .name to the concrete subclass, not the base class', () => {
    expect(new VerifyApiError('x', { stage: 'upload' }).name).toBe('VerifyApiError');
    expect(new VerifyRenderError('x', { stage: 'render' }).name).toBe('VerifyRenderError');
    expect(new VerifyValidationError('x', { stage: 'config' }).name).toBe('VerifyValidationError');
  });

  it('every VerifyError subclass is an instanceof VerifyError and Error', () => {
    const error = new VerifyRenderError('x', { stage: 'render' });
    expect(error).toBeInstanceOf(VerifyRenderError);
    expect(error).toBeInstanceOf(VerifyError);
    expect(error).toBeInstanceOf(Error);
  });
});
