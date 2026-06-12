import { describe, it, expect } from 'vitest';
import { sanitizeFilename } from './filename.js';

describe('sanitizeFilename', () => {
  it('returns a bare filename unchanged', () => {
    expect(sanitizeFilename('spec.sec')).toBe('spec.sec');
  });

  it('strips POSIX directory components — /home/user/uploads/spec.sec → spec.sec', () => {
    expect(sanitizeFilename('/home/user/uploads/spec.sec')).toBe('spec.sec');
  });

  it('strips Windows path fragments — C:\\fakepath\\spec.sec → spec.sec', () => {
    expect(sanitizeFilename('C:\\fakepath\\spec.sec')).toBe('spec.sec');
  });

  it('strips mixed separators — C:/fakepath\\sub/spec.sec → spec.sec', () => {
    expect(sanitizeFilename('C:/fakepath\\sub/spec.sec')).toBe('spec.sec');
  });
});
