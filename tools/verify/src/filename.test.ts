import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeRunFilename } from './filename.js';
import { VerifyValidationError } from './errors.js';

describe('sanitizeRunFilename', () => {
  it.each(['source.png', 'diff-001.png', 'report.json', 'a', '1.png', 'File_Name-2.PNG'])(
    'returns a well-formed bare filename unchanged: %s',
    (filename) => {
      expect(sanitizeRunFilename(filename)).toBe(filename);
    }
  );

  it('accepts a filename right at the 255-char cap and rejects one over it', () => {
    const atCap = `a${'b'.repeat(254)}`;
    expect(atCap).toHaveLength(255);
    expect(sanitizeRunFilename(atCap)).toBe(atCap);

    const overCap = `a${'b'.repeat(255)}`;
    expect(() => sanitizeRunFilename(overCap)).toThrow(VerifyValidationError);
  });

  it.each([
    ['', 'empty string'],
    ['..', 'bare parent-directory reference'],
    ['.', 'bare current-directory reference'],
    ['.hidden', 'leading-dot dotfile'],
    ['../evil.png', 'relative traversal'],
    ['../../etc/passwd', 'multi-level relative traversal'],
    ['/etc/passwd', 'absolute path'],
    ['foo/bar.png', 'embedded forward-slash separator'],
    ['foo\\bar.png', 'embedded backslash separator'],
    ['a\0b.png', 'embedded null byte'],
    ['..%2fetc%2fpasswd', 'percent-encoded traversal'],
    ['report .json', 'embedded space'],
  ])('rejects an unsafe filename (%s: %s)', (filename) => {
    expect(() => sanitizeRunFilename(filename)).toThrow(VerifyValidationError);
  });

  it('a rejected filename carries stage "report" and a descriptive, non-leaky message', () => {
    try {
      sanitizeRunFilename('../../etc/passwd');
      expect.unreachable('sanitizeRunFilename should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyValidationError);
      expect((error as VerifyValidationError).stage).toBe('report');
      expect((error as VerifyValidationError).message).toContain('unsafe run filename');
    }
  });

  // The core invariant this function exists to guarantee: joining any
  // filename that survives sanitization onto a run's artifact directory can
  // never resolve outside that directory, regardless of OS path separator.
  it('every accepted filename resolves inside the run directory when joined', () => {
    const runDir = resolve(process.cwd(), 'work', 'some-run-id');
    const accepted = ['source.png', 'diff-001.png', 'report.json', 'multi.part.name.png'];

    for (const filename of accepted) {
      const sanitized = sanitizeRunFilename(filename);
      const resolved = resolve(runDir, sanitized);
      expect(resolved.startsWith(runDir + sep)).toBe(true);
    }
  });
});
