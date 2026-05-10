import { describe, it, expect } from 'vitest';
import { getAttrVal, getAttrNumVal, extractAttrStr, toArray } from './xml-utils.js';

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
