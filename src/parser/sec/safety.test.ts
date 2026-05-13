import { describe, it, expect } from 'vitest';
import { assertSecSafe } from './safety.js';

describe('assertSecSafe', () => {
  it('rejects invalid UTF-8 byte sequence', () => {
    const buf = Buffer.from([0xc3, 0x28]); // malformed UTF-8 (incomplete 2-byte sequence)
    expect(() => assertSecSafe(buf)).toThrow('invalid UTF-8');
  });

  it('accepts valid UTF-8 SEC content', () => {
    const content = '<?xml version="1.0"?>\n<SEC>\n  <PRT ID="1">GENERAL</PRT>\n</SEC>';
    expect(() => assertSecSafe(Buffer.from(content, 'utf-8'))).not.toThrow();
  });

  it('rejects buffer containing a null byte', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x00<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('null byte');
  });

  it('rejects buffer containing ASCII control characters', () => {
    // BEL (\x07) — not whitespace, not valid SEC content
    const buf = Buffer.from('<?xml version="1.0"?>\x07<SEC/>', 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('control character');
  });

  it('rejects buffer with a line exceeding 4096 characters', () => {
    const longLine = 'A'.repeat(4097);
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('line too long');
  });
});
