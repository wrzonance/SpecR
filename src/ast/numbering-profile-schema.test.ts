import { describe, it, expect } from 'vitest';
import { NumberingProfileSchema, NumberingProfileReadSchema, tierForIlvl } from './index.js';

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

// #319: tier is derived from (ilvl, articleIlvl), not authoritative client input —
// see ADR-067. The server fills an omitted tier and rejects one that disagrees
// with the derivation, naming the offending entry.
describe('NumberingProfileSchema — tier derivation (#319)', () => {
  const valid = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [{ numId: 12, levels: [{ ilvl: 0, tier: 'part', labelTemplate: 'PART %1' }] }],
    styleLadder: [{ styleId: 'PART', numId: 12, ilvl: 0, tier: 'part' }],
    articleIlvl: 1,
  };

  it('rejects a styleLadder entry whose declared tier disagrees with the derivation', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        ...valid,
        styleLadder: [{ styleId: 'ARTICLE', numId: 12, ilvl: 1, tier: 'part' }],
      })
    ).toThrow(/styleLadder\[styleId=ARTICLE\].*derives to 'article'/);
  });

  it('rejects a numbering.levels entry whose declared tier disagrees with the derivation', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        ...valid,
        numbering: [{ numId: 12, levels: [{ ilvl: 1, tier: 'part' }] }],
      })
    ).toThrow(/numbering\[numId=12\].*derives to 'article'/);
  });

  it('rejects a non-empty numbering with articleIlvl omitted', () => {
    const withoutArticleIlvl = {
      tiers: valid.tiers,
      numbering: valid.numbering,
      styleLadder: valid.styleLadder,
    };
    expect(() => NumberingProfileSchema.parse(withoutArticleIlvl)).toThrow(
      /articleIlvl is required/
    );
  });

  it('rejects a non-empty styleLadder with articleIlvl omitted, even if numbering is empty', () => {
    expect(() =>
      NumberingProfileSchema.parse({
        tiers: valid.tiers,
        numbering: [],
        styleLadder: valid.styleLadder,
      })
    ).toThrow(/articleIlvl is required/);
  });

  it('accepts an empty profile with articleIlvl omitted (nothing to derive)', () => {
    const parsed = NumberingProfileSchema.parse({
      tiers: valid.tiers,
      numbering: [],
      styleLadder: [],
    });
    expect(parsed.articleIlvl).toBeUndefined();
    expect(parsed.numbering).toEqual([]);
    expect(parsed.styleLadder).toEqual([]);
  });

  it('fills an omitted tier with the value derived from (ilvl, articleIlvl)', () => {
    const parsed = NumberingProfileSchema.parse({
      ...valid,
      numbering: [{ numId: 12, levels: [{ ilvl: 2 }] }],
      styleLadder: [{ styleId: 'PARA', numId: 12, ilvl: 2 }],
    });
    expect(parsed.numbering[0]?.levels[0]?.tier).toBe(tierForIlvl(2, 1));
    expect(parsed.styleLadder[0]?.tier).toBe(tierForIlvl(2, 1));
  });

  it('accepts a fully-consistent profile with every tier declared', () => {
    const parsed = NumberingProfileSchema.parse(valid);
    expect(parsed.numbering[0]?.levels[0]?.tier).toBe('part');
    expect(parsed.styleLadder[0]?.tier).toBe('part');
  });

  it('is idempotent: re-parsing the already-transformed output succeeds unchanged', () => {
    const once = NumberingProfileSchema.parse(valid);
    const twice = NumberingProfileSchema.parse(once);
    expect(twice).toEqual(once);
  });
});

// #323: the read schema is the write schema with numeric POLICY bounds relaxed, so
// rows persisted under an older, looser contract read back cleanly instead of 500ing
// once the write schema tightens. It stays strict about SHAPE (see the reject tests).
describe('NumberingProfileReadSchema (read-tolerant — #323)', () => {
  const valid = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [{ numId: 12, levels: [{ ilvl: 0, tier: 'part', labelTemplate: 'PART %1' }] }],
    styleLadder: [{ styleId: 'PART', numId: 12, ilvl: 0, tier: 'part' }],
    articleIlvl: 1,
  };

  it('accepts a legacy articleIlvl 0 that the strict write schema now rejects (the #320 example)', () => {
    // Concrete case from #322/#320: a profile persisted before articleIlvl.min(1).
    expect(() => NumberingProfileSchema.parse({ ...valid, articleIlvl: 0 })).toThrow();
    const parsed = NumberingProfileReadSchema.parse({ ...valid, articleIlvl: 0 });
    expect(parsed.articleIlvl).toBe(0);
  });

  it('accepts a legacy part maxCount above the strict CSI bound (>5)', () => {
    const legacy = { ...valid, tiers: { part: { numberStyle: 'integer', maxCount: 7 } } };
    expect(() => NumberingProfileSchema.parse(legacy)).toThrow();
    const parsed = NumberingProfileReadSchema.parse(legacy);
    expect(parsed.tiers.part.maxCount).toBe(7);
  });

  it('round-trips unknown keys the same way the write schema does (ADR-021)', () => {
    const parsed = NumberingProfileReadSchema.parse({ ...valid, vendorX: { note: 'keep me' } });
    expect((parsed as Record<string, unknown>)['vendorX']).toEqual({ note: 'keep me' });
  });

  // Read-tolerant is NOT a rubber stamp: structural corruption must still throw, so a
  // genuinely-broken row surfaces as an error rather than silently propagating.
  it('still rejects a structurally-broken row (missing the required part tier)', () => {
    expect(() => NumberingProfileReadSchema.parse({ ...valid, tiers: {} })).toThrow();
  });

  it('still rejects an unknown tier name in a numbering level (closed vocabulary)', () => {
    expect(() =>
      NumberingProfileReadSchema.parse({
        ...valid,
        numbering: [{ numId: 1, levels: [{ ilvl: 0, tier: 'chapter' }] }],
      })
    ).toThrow();
  });

  // #323 (Codex): the read schema relaxes to the STRUCTURAL FLOOR, not below it. A
  // negative level is corruption (never valid under any historical contract), and
  // ilvlToNodeType uses articleIlvl as a subtraction offset — a negative would silently
  // shift every tier. So sub-structural values must still throw, not read back.
  it('still rejects a negative articleIlvl (corruption, not a legacy shape)', () => {
    expect(() => NumberingProfileReadSchema.parse({ ...valid, articleIlvl: -1 })).toThrow();
  });

  it('still rejects a negative ilvl in a numbering level (structural floor is 0)', () => {
    expect(() =>
      NumberingProfileReadSchema.parse({
        ...valid,
        numbering: [{ numId: 1, levels: [{ ilvl: -1, tier: 'part' }] }],
      })
    ).toThrow();
  });

  it('still rejects a non-positive part maxCount (a tier size must be >= 1)', () => {
    const broken = { ...valid, tiers: { part: { numberStyle: 'integer', maxCount: 0 } } };
    expect(() => NumberingProfileReadSchema.parse(broken)).toThrow();
  });

  // The read schema deliberately does NOT run checkTierEntriesMatchDerived (#319):
  // a persisted row was already validated as consistent at write time, so read never
  // re-derives or re-checks tier — it trusts the stored value verbatim. Pin that the
  // exact declared-vs-derived divergence the write schema rejects (see the
  // 'tier derivation (#319)' describe block above) still reads back unchanged.
  it('accepts a styleLadder entry whose declared tier disagrees with the derivation (read trusts the stored tier, #319)', () => {
    const divergent = {
      ...valid,
      styleLadder: [{ styleId: 'ARTICLE', numId: 12, ilvl: 1, tier: 'part' }],
    };
    expect(() => NumberingProfileSchema.parse(divergent)).toThrow(
      /styleLadder\[styleId=ARTICLE\].*derives to 'article'/
    );
    const parsed = NumberingProfileReadSchema.parse(divergent);
    expect(parsed.styleLadder[0]?.tier).toBe('part');
  });

  it('accepts a numbering.levels entry whose declared tier disagrees with the derivation (read trusts the stored tier, #319)', () => {
    const divergent = {
      ...valid,
      numbering: [{ numId: 12, levels: [{ ilvl: 1, tier: 'part' }] }],
    };
    expect(() => NumberingProfileSchema.parse(divergent)).toThrow(
      /numbering\[numId=12\].*derives to 'article'/
    );
    const parsed = NumberingProfileReadSchema.parse(divergent);
    expect(parsed.numbering[0]?.levels[0]?.tier).toBe('part');
  });
});
