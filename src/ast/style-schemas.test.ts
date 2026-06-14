import { describe, it, expect } from 'vitest';
import {
  AddSectionToProjectBodySchema,
  GenerateBodySchema,
  PatchProjectBodySchema,
  PatchSpecBodySchema,
  StylePropertiesSchema,
} from './schemas.js';

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

describe('PatchProjectBodySchema', () => {
  it('accepts project rename and section-number format settings', () => {
    expect(
      PatchProjectBodySchema.parse({ name: 'Courthouse', sectionNumberFormat: 'compact' })
    ).toEqual({ name: 'Courthouse', sectionNumberFormat: 'compact' });
  });

  it('rejects empty project settings and unknown section-number formats', () => {
    expect(() => PatchProjectBodySchema.parse({})).toThrow();
    expect(() => PatchProjectBodySchema.parse({ sectionNumberFormat: 'slashes' })).toThrow();
  });
});

describe('GenerateBodySchema (generate request body)', () => {
  it('accepts an empty body', () => {
    expect(GenerateBodySchema.parse({})).toEqual({});
  });

  it('accepts a valid templateId UUID', () => {
    const body = { templateId: '0a4d4567-1b2c-4d3e-9f00-abcdefabcdef' };
    expect(GenerateBodySchema.parse(body)).toEqual(body);
  });

  it('accepts sectionNumberFormat output policy', () => {
    expect(GenerateBodySchema.parse({ sectionNumberFormat: 'dots' })).toEqual({
      sectionNumberFormat: 'dots',
    });
  });

  it('rejects a non-UUID templateId', () => {
    expect(() => GenerateBodySchema.parse({ templateId: 'not-a-uuid' })).toThrow();
  });

  it('rejects an unknown sectionNumberFormat', () => {
    expect(() => GenerateBodySchema.parse({ sectionNumberFormat: 'slashes' })).toThrow();
  });

  it('rejects explicit undefined templateId (exactOptional)', () => {
    expect(() => GenerateBodySchema.parse({ templateId: undefined })).toThrow();
  });
});

describe('Section-number API input schemas', () => {
  it('normalizes PATCH /specs section display variants', () => {
    expect(PatchSpecBodySchema.parse({ section: '09.91.00' })).toEqual({
      section: '09 91 00',
    });
  });

  it('normalizes POST /projects/:id/specs section display variants', () => {
    expect(AddSectionToProjectBodySchema.parse({ section: '099100' })).toEqual({
      section: '09 91 00',
    });
  });

  it('rejects malformed section input', () => {
    expect(() => PatchSpecBodySchema.parse({ section: '09910' })).toThrow();
    expect(() => AddSectionToProjectBodySchema.parse({ section: '09.910.0' })).toThrow();
  });
});
