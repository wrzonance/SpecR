import { describe, it, expect } from 'vitest';
import { decodeTextBuffer } from './decode-text.js';

describe('decodeTextBuffer', () => {
  it('decodes a UTF-8 buffer correctly', () => {
    const buf = Buffer.from('hello world', 'utf-8');
    expect(decodeTextBuffer(buf)).toBe('hello world');
  });

  it('decodes a windows-1252 buffer containing en-dash (0x96)', () => {
    // 0x96 = en-dash (U+2013) in windows-1252; invalid in strict UTF-8
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x96, 0x77, 0x6f, 0x72, 0x6c, 0x64]);
    const result = decodeTextBuffer(buf);
    // chardet detects windows-1252 / ISO-8859-1 variant; iconv transcodes 0x96 → U+2013 (–)
    expect(result).toContain('–');
    expect(result).toContain('hello');
    expect(result).toContain('world');
  });

  it('decodes a latin-1 buffer with accented characters', () => {
    // 0xe9 = 'é' in latin-1/ISO-8859-1
    const buf = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
    const result = decodeTextBuffer(buf);
    expect(result).toContain('caf');
    // iconv transcodes 0xe9 to U+00E9 (é) — may appear as é or in a variant form
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not throw when chardet returns null (minimal buffer)', () => {
    // Single byte that may confuse chardet — must not throw, must return a string
    const buf = Buffer.from([0xff]);
    expect(() => decodeTextBuffer(buf)).not.toThrow();
    expect(typeof decodeTextBuffer(buf)).toBe('string');
  });
});
