import { describe, it, expect } from 'vitest';
import { GeneratorError } from './error.js';
import { SpecrError } from '../lib/errors.js';

describe('GeneratorError', () => {
  it('is an instance of SpecrError and Error', () => {
    const err = new GeneratorError('test message');
    expect(err).toBeInstanceOf(SpecrError);
    expect(err).toBeInstanceOf(Error);
  });

  it('has name GeneratorError', () => {
    const err = new GeneratorError('test message');
    expect(err.name).toBe('GeneratorError');
  });

  it('sets message correctly', () => {
    const err = new GeneratorError('something went wrong');
    expect(err.message).toBe('something went wrong');
  });

  it('chains cause', () => {
    const cause = new Error('root cause');
    const err = new GeneratorError('wrapper', { cause });
    expect(err.cause).toBe(cause);
  });
});
