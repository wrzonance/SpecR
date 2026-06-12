import { describe, it, expect } from 'vitest';
import { buildRuleMap, runStyleOptions, paragraphStyleOptions } from './styles.js';
import type { StyleRule } from '../ast/index.js';

describe('buildRuleMap', () => {
  it('maps nodeType to properties', () => {
    const rules: StyleRule[] = [{ nodeType: 'part', properties: { rPr: { b: true } } }];
    const map = buildRuleMap(rules);
    expect(map.get('part')).toEqual({ rPr: { b: true } });
    expect(map.get('article')).toBeUndefined();
  });
});

describe('runStyleOptions', () => {
  it('returns {} for undefined rPr', () => {
    expect(runStyleOptions(undefined)).toEqual({});
  });

  it('maps font family, size, bold, italics, caps, smallCaps', () => {
    expect(
      runStyleOptions({
        rFonts: { ascii: 'Arial' },
        sz: 24,
        b: true,
        i: true,
        caps: true,
        smallCaps: false,
      })
    ).toEqual({
      font: { ascii: 'Arial' },
      size: 24,
      bold: true,
      italics: true,
      allCaps: true,
      smallCaps: false,
    });
  });

  it('preserves non-ascii rFonts slots (hAnsi/cs/eastAsia) in the font object', () => {
    expect(
      runStyleOptions({
        rFonts: { ascii: 'Arial', hAnsi: 'Arial', cs: 'Courier New', eastAsia: 'MS Mincho' },
      })
    ).toEqual({
      font: { ascii: 'Arial', hAnsi: 'Arial', cs: 'Courier New', eastAsia: 'MS Mincho' },
    });
  });

  it('rFonts with only non-ascii slots still maps a font (regression: ascii-only slot dropped hAnsi/cs/eastAsia)', () => {
    expect(runStyleOptions({ rFonts: { eastAsia: 'MS Mincho' } })).toEqual({
      font: { eastAsia: 'MS Mincho' },
    });
  });

  it('rFonts with no known slots (catchall-only keys) yields no font key', () => {
    expect(runStyleOptions({ rFonts: { hint: 'eastAsia' } })).toEqual({});
  });

  it('omits keys absent from the payload (exactOptionalPropertyTypes-safe)', () => {
    expect(runStyleOptions({ sz: 20 })).toEqual({ size: 20 });
  });
});

describe('paragraphStyleOptions', () => {
  it('returns {} for undefined pPr', () => {
    expect(paragraphStyleOptions(undefined)).toEqual({});
  });

  // lineRule and jc values equal their OOXML string keys today (identity coincidence — lookup is for type-safety)
  it('maps spacing before/after/line/lineRule', () => {
    expect(
      paragraphStyleOptions({ spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' } })
    ).toEqual({ spacing: { before: 0, after: 120, line: 360, lineRule: 'auto' } });
  });

  it('maps contextualSpacing out of the spacing object onto the paragraph', () => {
    expect(paragraphStyleOptions({ spacing: { contextualSpacing: true } })).toEqual({
      spacing: {},
      contextualSpacing: true,
    });
  });

  it('maps indent left/right/firstLine/hanging', () => {
    expect(paragraphStyleOptions({ ind: { left: 720, hanging: 360 } })).toEqual({
      indent: { left: 720, hanging: 360 },
    });
  });

  it('maps jc to alignment', () => {
    expect(paragraphStyleOptions({ jc: 'center' })).toEqual({ alignment: 'center' });
  });
});
