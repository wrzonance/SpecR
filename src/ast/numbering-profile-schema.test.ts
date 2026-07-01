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

  it('round-trips unknown keys at the tiers container level (ADR-021)', () => {
    const parsed = NumberingProfileSchema.parse({
      ...valid,
      tiers: { ...valid.tiers, vendorTierMeta: { keep: true } },
    });
    expect((parsed.tiers as Record<string, unknown>)['vendorTierMeta']).toEqual({ keep: true });
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

  // #320: articleIlvl 0 is unrepresentable — ilvlToNodeType always maps ilvl 0 to
  // 'part', so an article could never appear (and no PART tier could exist below it).
  // Reject it at the boundary rather than accept a profile that corrupts hierarchy.
  it('rejects articleIlvl 0 (article can never share ilvl 0 with part)', () => {
    expect(() => NumberingProfileSchema.parse({ ...valid, articleIlvl: 0 })).toThrow();
  });

  it('accepts articleIlvl 1 (the minimum valid Article level)', () => {
    const parsed = NumberingProfileSchema.parse({ ...valid, articleIlvl: 1 });
    expect(parsed.articleIlvl).toBe(1);
  });
});
