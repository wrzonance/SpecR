import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { assertSecSafe } from './safety.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '../../..');

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

  it('strips XML-unsafe ASCII control characters', () => {
    const buf = Buffer.from('<?xml version="1.0"?>\x07<SEC/>', 'utf-8');
    expect(assertSecSafe(buf)).toBe('<?xml version="1.0"?><SEC/>');
  });

  it('regression: strips legacy DC3 controls from dirty SEC text', () => {
    const buf = Buffer.from('<SEC><TXT>Dental Surgical Vacuum\x13</TXT></SEC>', 'utf-8');
    expect(assertSecSafe(buf)).toBe('<SEC><TXT>Dental Surgical Vacuum</TXT></SEC>');
  });

  // This is the only test that runs full-buffer charset detection (chardet) over
  // real ~500 KB UFGS files. The work itself is ~130 ms, but under the parallel
  // coverage suite on a 2-core CI runner, CPU contention inflates its wall-clock
  // past the default 5 s timeout (observed 5.16 s in CI, 2.47 s pinned to 2 cores
  // locally). Give it generous headroom — the code is fast; the runner is starved.
  it('regression: reported UFGS files with DC3 controls are upload-safe', () => {
    const filenames = [
      'docs/references/UFGS/DIVISION_22/22_60_70.SEC',
      'docs/references/UFGS/DIVISION_35/35_05_40.14_10.SEC',
    ];

    for (const filename of filenames) {
      const sanitized = assertSecSafe(readFileSync(resolve(PROJECT_ROOT, filename)));
      expect(sanitized).not.toContain('\x13');
      expect(sanitized).toContain('<SCN>');
    }
  }, 20_000);

  it('rejects buffer with a line exceeding 65536 characters', () => {
    const longLine = 'A'.repeat(65537);
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8');
    expect(() => assertSecSafe(buf)).toThrow('line too long');
  });

  it('accepts a real UFGS <REF> line of ~8596 characters', () => {
    // UFGS 27 10 00 has a reference block on a single line of 8596 chars — must not throw.
    const longLine = 'A'.repeat(8596);
    const buf = Buffer.from(`<?xml?>\n${longLine}\n</SEC>`, 'utf-8');
    expect(() => assertSecSafe(buf)).not.toThrow();
  });
});
