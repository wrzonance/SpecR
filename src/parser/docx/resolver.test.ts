import { describe, it, expect } from 'vitest';
import { extractRunProps, extractParaProps } from './resolver.js';

describe('extractRunProps', () => {
  it('reads fonts, size, toggles, underline, color from a w:rPr object', () => {
    const rPr = {
      'w:rFonts': { '@_w:ascii': 'Courier New' },
      'w:sz': { '@_w:val': 20 },
      'w:b': '', // fxp emits '' for self-closing <w:b/>

      'w:i': { '@_w:val': '0' }, // explicit off → false
      'w:caps': { '@_w:val': '1' }, // explicit on → true
      'w:u': { '@_w:val': 'single' },
      'w:color': { '@_w:val': 'FF0000' },
    };
    expect(extractRunProps(rPr)).toEqual({
      rFonts: { ascii: 'Courier New' },
      sz: 20,
      b: true,
      i: false,
      caps: true,
      u: 'single',
      color: 'FF0000',
    });
  });

  it('returns an empty object for an empty w:rPr', () => {
    expect(extractRunProps({})).toEqual({});
  });
});

describe('extractParaProps', () => {
  it('reads spacing, indent, alignment from a w:pPr object', () => {
    const pPr = {
      'w:spacing': { '@_w:before': 0, '@_w:after': 120, '@_w:line': 360, '@_w:lineRule': 'auto' },
      'w:ind': { '@_w:left': 720, '@_w:hanging': 360 },
      'w:jc': { '@_w:val': 'both' },
    };
    expect(extractParaProps(pPr)).toEqual({
      spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' },
      ind: { left: 720, hanging: 360 },
      jc: 'both',
    });
  });

  it('extracts contextualSpacing (a w:pPr sibling) under spacing', () => {
    expect(extractParaProps({ 'w:contextualSpacing': '' })).toEqual({
      spacing: { contextualSpacing: true },
    });
  });

  it('returns an empty object for an empty w:pPr', () => {
    expect(extractParaProps({})).toEqual({});
  });
});
