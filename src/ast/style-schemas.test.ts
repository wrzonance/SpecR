import { describe, it, expect } from 'vitest';
import { StylePropertiesSchema } from './schemas.js';

describe('StylePropertiesSchema (ADR-021 open style payload)', () => {
  it('parses a known OOXML-faithful definition unchanged', () => {
    const input = {
      rPr: { rFonts: { ascii: 'Courier New' }, sz: 20, b: true, caps: true },
      pPr: { spacing: { before: 0, after: 120 }, ind: { left: 0 } },
      numbering: { ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1 -' },
    };
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });

  it('preserves UNKNOWN OOXML properties at every level (footgun closed)', () => {
    const input = {
      rPr: { sz: 24, unknownRunProp: 'x' },
      pPr: { pBdr: { top: { val: 'single', sz: 4 } }, vendorExt: { foo: 1 } },
      topLevelUnknown: true,
    };
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });

  it('rejects a structurally-wrong KNOWN key (sz must be an integer)', () => {
    expect(() => StylePropertiesSchema.parse({ rPr: { sz: 'big' } })).toThrow();
  });

  it('allows a negative left indent (signed OOXML unit — never reject the source)', () => {
    const input = { pPr: { ind: { left: -360 } } };
    expect(StylePropertiesSchema.parse(input)).toEqual(input);
  });

  it('rejects a non-JSON value in an unknown key (the JSONB column holds only JSON)', () => {
    // Would otherwise throw (BigInt) or be silently dropped (function/symbol) on
    // JSON.stringify at the DB boundary — reject it at parse instead.
    expect(() => StylePropertiesSchema.parse({ weird: 10n })).toThrow();
    expect(() => StylePropertiesSchema.parse({ pPr: { vendorFn: () => 1 } })).toThrow();
  });
});
