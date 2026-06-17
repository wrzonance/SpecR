import { describe, it, expect } from 'vitest';
import { encodeXmlEntities } from './entities.js';
import { decodeXmlEntities } from '../../parser/sec/entities.js';

describe('encodeXmlEntities', () => {
  it('escapes the five XML metacharacters', () => {
    expect(encodeXmlEntities(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });

  it('escapes & exactly once (no double-escape of introduced entities)', () => {
    expect(encodeXmlEntities('O&M')).toBe('O&amp;M');
    expect(encodeXmlEntities('a < b')).toBe('a &lt; b');
  });

  it('is the inverse of decodeXmlEntities for the five named entities', () => {
    const samples = [
      'O&M MANUAL CONTENT',
      'OPERATION & MAINTENANCE DATA',
      `Clearance < 600 mm > 300 mm; use O'Brien fittings`,
      'literal entity: &amp; stays escaped once',
      'no metacharacters here',
    ];
    for (const s of samples) {
      expect(decodeXmlEntities(encodeXmlEntities(s))).toBe(s);
    }
  });

  it('leaves plain text untouched', () => {
    expect(encodeXmlEntities('plain text 123')).toBe('plain text 123');
  });
});
