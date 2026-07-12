import { describe, it, expect } from 'vitest';
import {
  createDocumentXmlParser,
  getAttrVal,
  getAttrNumVal,
  extractAttrStr,
  toArray,
} from './xml-utils.js';

// The factory is the single source of the document.xml parser config shared by
// document.ts and tables.ts (#293). These pin the config guarantees the reused
// text/vanish helpers depend on, so drift (or a bad refactor) fails here — not silently
// in one scanner. See the #22/#120 rationale on createDocumentXmlParser.
describe('createDocumentXmlParser', () => {
  interface Run {
    readonly 'w:t'?: unknown;
  }
  interface Para {
    readonly 'w:r'?: readonly Run[];
    readonly 'w:pPr'?: unknown;
  }
  const parseP = (xml: string): Para | undefined => {
    const parsed = createDocumentXmlParser(['w:p', 'w:r']).parse(xml) as {
      readonly 'w:p'?: readonly Para[];
    };
    return parsed['w:p']?.[0];
  };
  const firstRunText = (xml: string): unknown => parseP(xml)?.['w:r']?.[0]?.['w:t'];

  it('keeps a bare-integer w:t run as a string, never coerced to a number (#120)', () => {
    expect(firstRunText('<w:p><w:r><w:t>9</w:t></w:r></w:p>')).toBe('9');
  });

  it('preserves leading/trailing whitespace in w:t text (trimValues: false)', () => {
    expect(firstRunText('<w:p><w:r><w:t> x </w:t></w:r></w:p>')).toBe(' x ');
  });

  it('decodes OOXML entities in text (processEntities: true)', () => {
    expect(firstRunText('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>')).toBe('a & b');
  });

  it('forces the requested tags to arrays even when a single element is present', () => {
    expect(Array.isArray(parseP('<w:p><w:r><w:t>only</w:t></w:r></w:p>')?.['w:r'])).toBe(true);
  });

  it('does not array-wrap a tag outside the requested set', () => {
    expect(Array.isArray(parseP('<w:p><w:pPr/><w:r><w:t>x</w:t></w:r></w:p>')?.['w:pPr'])).toBe(
      false
    );
  });
});

describe('getAttrVal', () => {
  it('returns string value from @_w:val', () => {
    expect(getAttrVal({ '@_w:val': 'decimal' })).toBe('decimal');
  });

  it('converts numeric @_w:val to string', () => {
    expect(getAttrVal({ '@_w:val': 3 })).toBe('3');
  });

  it('returns empty string when @_w:val is missing', () => {
    expect(getAttrVal({ other: 'x' })).toBe('');
  });

  it('returns empty string for non-object input', () => {
    expect(getAttrVal('literal')).toBe('');
    expect(getAttrVal(null)).toBe('');
    expect(getAttrVal(undefined)).toBe('');
  });
});

describe('getAttrNumVal', () => {
  it('parses numeric string to int', () => {
    expect(getAttrNumVal({ '@_w:val': '4' })).toBe(4);
  });

  it('returns 0 for unparseable value', () => {
    expect(getAttrNumVal({})).toBe(0);
  });
});

describe('extractAttrStr', () => {
  it('extracts string attribute', () => {
    expect(extractAttrStr({ '@_w:numId': '1' }, '@_w:numId')).toBe('1');
  });

  it('converts numeric attribute to string', () => {
    expect(extractAttrStr({ '@_w:abstractNumId': 0 }, '@_w:abstractNumId')).toBe('0');
  });

  it('returns empty string for missing key', () => {
    expect(extractAttrStr({}, '@_w:missing')).toBe('');
  });
});

describe('toArray', () => {
  it('wraps single item in array', () => {
    expect(toArray('x')).toEqual(['x']);
  });

  it('returns array as-is', () => {
    expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty array for undefined', () => {
    expect(toArray(undefined)).toEqual([]);
  });
});
