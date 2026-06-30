import { describe, it, expect } from 'vitest';
import { NumberingProfileSchema } from './index.js';

describe('NumberingProfileSchema', () => {
  const valid = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [{ numId: 12, levels: [{ ilvl: 0, tier: 'part', labelTemplate: 'PART %1' }] }],
    styleLadder: [{ styleId: 'PART', numId: 12, ilvl: 0, tier: 'part' }],
    articleIlvl: 1,
  };

  it('accepts a well-formed profile and round-trips unknown keys', () => {
    const parsed = NumberingProfileSchema.parse({ ...valid, vendorX: { note: 'keep me' } });
    expect(parsed.tiers.part.maxCount).toBe(5);
    expect((parsed as Record<string, unknown>)['vendorX']).toEqual({ note: 'keep me' });
  });

  it('rejects a part tier with maxCount > 5 (CSI integer-part bound)', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        ...valid,
        tiers: { part: { numberStyle: 'integer', maxCount: 6 } },
      })
    ).toThrow();
  });

  it('rejects a non-integer part numberStyle', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        ...valid,
        tiers: { part: { numberStyle: 'decimal', maxCount: 5 } },
      })
    ).toThrow();
  });

  it('rejects an unknown tier name in a numbering level', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        ...valid,
        numbering: [{ numId: 1, levels: [{ ilvl: 0, tier: 'chapter' }] }],
      })
    ).toThrow();
  });
});
