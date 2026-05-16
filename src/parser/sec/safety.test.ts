import { describe, it, expect } from 'vitest';
import { assertSecSafe } from './safety.js';

describe('assertSecSafe', () => {
  it('accepts windows-1252 bytes that fail strict UTF-8 validation', () => {
    // 0x96 = en-dash (U+2013) in windows-1252; was previously rejected as "invalid UTF-8"
    const buf = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x96]);
    expect(() => assertSecSafe(buf)).not.toThrow();
  });

  it('accepts valid UTF-8 SEC content and returns a string', () => {
    const content = '<?xml version="1.0"?>\n<SEC>\n  <PRT ID="1">GENERAL</PRT>\n</SEC>';
    const result = assertSecSafe(Buffer.from(content, 'utf-8'));
    expect(typeof result).toBe('string');
    expect(result).toContain('<SEC>');
  });

  it('returns decoded string for windows-1252 input', () => {
    // Build a minimal windows-1252 buffer
    const buf = Buffer.from([0x41, 0x96, 0x42]); // 'A' + en-dash (U+2013) + 'B' in windows-1252
    const result = assertSecSafe(buf);
    expect(typeof result).toBe('string');
    expect(result).toContain('A');
    expect(result).toContain('–'); // 0x96 → U+2013 en-dash
    expect(result).toContain('B');
  });

  it('rejects buffer containing a null byte', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x00<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('null byte');
  });

  it('rejects buffer containing ASCII control characters', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x07<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('control character');
  });

  it('rejects buffer with a line exceeding 4096 characters', () => {
    const longLine = 'A'.repeat(4097);
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('line too long');
  });
});
