import { describe, it, expect } from 'vitest';
import { extractNumberingProfile } from './numbering-profile.js';
import { NumberingProfileSchema } from '../../ast/index.js';
import type { NumberingMap, StyleMap } from './types.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function arcatFixture(): { map: NumberingMap; styles: StyleMap } {
  const map: NumberingMap = {
    nums: new Map([[1, { numId: 1, abstractNumId: 0 }]]),
    abstractNums: new Map([
      [
        0,
        {
          abstractNumId: 0,
          levels: [
            { ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1', pStyle: 'ARCATPart' },
            { ilvl: 1, numFmt: 'decimal', lvlText: '%1.%2', pStyle: 'ARCATArticle' },
            { ilvl: 2, numFmt: 'upperLetter', lvlText: '%3.', pStyle: 'ARCATParagraph' },
            { ilvl: 3, numFmt: 'lowerLetter', lvlText: '%4)' },
          ],
        },
      ],
    ]),
    pStyleToNumId: new Map([
      ['ARCATPart', 1],
      ['ARCATArticle', 1],
    ]),
    pStyleToIlvl: new Map([
      ['ARCATPart', 0],
      ['ARCATArticle', 1],
    ]),
    articleIlvl: 1,
    specShapedNumIds: new Set([1]),
  };
  // ARCATParagraph is only in resolvedNumPr — tests the union path
  const styles: StyleMap = {
    styles: new Map(),
    resolvedNumPr: new Map([['ARCATParagraph', { numId: 1, ilvl: 2 }]]),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
  };
  return { map, styles };
}

function cpiFixture(): { map: NumberingMap; styles: StyleMap } {
  // articleIlvl=3 (low levels reserved) — ilvl 0-2 are PART, ilvl 3 is article, ilvl 4 is paragraph
  const map: NumberingMap = {
    nums: new Map([[2, { numId: 2, abstractNumId: 1 }]]),
    abstractNums: new Map([
      [
        1,
        {
          abstractNumId: 1,
          levels: [
            { ilvl: 0, numFmt: 'decimal' },
            { ilvl: 1, numFmt: 'decimal' },
            { ilvl: 2, numFmt: 'decimal' },
            { ilvl: 3, numFmt: 'decimal', lvlText: 'ARTICLE %4', pStyle: 'ART' },
            { ilvl: 4, numFmt: 'decimal', lvlText: '%4.%5', pStyle: 'PR1' },
            { ilvl: 5, numFmt: 'upperLetter', lvlText: '%6.' },
          ],
        },
      ],
    ]),
    pStyleToNumId: new Map([
      ['PRT', 2],
      ['ART', 2],
    ]),
    pStyleToIlvl: new Map([
      ['PRT', 0],
      ['ART', 3],
    ]),
    articleIlvl: 3,
    specShapedNumIds: new Set([2]),
  };
  const styles: StyleMap = {
    styles: new Map(),
    resolvedNumPr: new Map([['PR1', { numId: 2, ilvl: 4 }]]),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
  };
  return { map, styles };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('extractNumberingProfile — articleIlvl=1 (no reserved levels)', () => {
  const { map, styles } = arcatFixture();
  const profile = extractNumberingProfile(map, styles);

  it('emits tiers.part pinned to CSI integer model', () => {
    expect(profile.tiers.part).toEqual({ numberStyle: 'integer', maxCount: 5 });
  });

  it('emits articleIlvl from map', () => {
    expect(profile.articleIlvl).toBe(1);
  });

  it('assigns tier correctly per ilvl boundary', () => {
    const levels = profile.numbering[0]?.levels ?? [];
    expect(levels[0]).toMatchObject({ ilvl: 0, tier: 'part' });
    expect(levels[1]).toMatchObject({ ilvl: 1, tier: 'article' });
    expect(levels[2]).toMatchObject({ ilvl: 2, tier: 'paragraph' });
    expect(levels[3]).toMatchObject({ ilvl: 3, tier: 'subparagraph' });
  });

  it('maps lvlText → labelTemplate', () => {
    const levels = profile.numbering[0]?.levels ?? [];
    expect(levels[0]?.labelTemplate).toBe('PART %1');
    expect(levels[1]?.labelTemplate).toBe('%1.%2');
  });

  it('maps numFmt', () => {
    const levels = profile.numbering[0]?.levels ?? [];
    expect(levels[0]?.numFmt).toBe('decimal');
    expect(levels[2]?.numFmt).toBe('upperLetter');
  });

  it('styleLadder includes pStyle entries + resolvedNumPr union, sorted by styleId', () => {
    const ids = profile.styleLadder.map((e) => e.styleId);
    // ARCATArticle from pStyleToNumId/pStyleToIlvl, ARCATParagraph from resolvedNumPr
    expect(ids).toEqual(['ARCATArticle', 'ARCATParagraph', 'ARCATPart']);
  });

  it('styleLadder entries carry correct numId/ilvl/tier', () => {
    const article = profile.styleLadder.find((e) => e.styleId === 'ARCATArticle');
    const paragraph = profile.styleLadder.find((e) => e.styleId === 'ARCATParagraph');
    const part = profile.styleLadder.find((e) => e.styleId === 'ARCATPart');
    expect(article).toEqual({ styleId: 'ARCATArticle', numId: 1, ilvl: 1, tier: 'article' });
    expect(paragraph).toEqual({ styleId: 'ARCATParagraph', numId: 1, ilvl: 2, tier: 'paragraph' });
    expect(part).toEqual({ styleId: 'ARCATPart', numId: 1, ilvl: 0, tier: 'part' });
  });

  it('profile passes NumberingProfileSchema.parse (round-trip validity)', () => {
    expect(() => NumberingProfileSchema.parse(profile)).not.toThrow();
  });
});

describe('extractNumberingProfile — articleIlvl=3 (low levels reserved)', () => {
  const { map, styles } = cpiFixture();
  const profile = extractNumberingProfile(map, styles);

  it('emits articleIlvl=3 from map', () => {
    expect(profile.articleIlvl).toBe(3);
  });

  it('articleIlvl=3 ilvl boundary: ilvl<3 → part, ilvl=3 → article, ilvl=4 → paragraph, ilvl=5 → subparagraph', () => {
    const levels = profile.numbering[0]?.levels ?? [];
    // ilvl 0,1,2 are all below articleIlvl=3 → part
    expect(levels[0]).toMatchObject({ ilvl: 0, tier: 'part' });
    expect(levels[1]).toMatchObject({ ilvl: 1, tier: 'part' });
    expect(levels[2]).toMatchObject({ ilvl: 2, tier: 'part' });
    // ilvl=3 is articleIlvl → article
    expect(levels[3]).toMatchObject({ ilvl: 3, tier: 'article', labelTemplate: 'ARTICLE %4' });
    // ilvl=4 is articleIlvl+1 → paragraph
    expect(levels[4]).toMatchObject({ ilvl: 4, tier: 'paragraph' });
    // ilvl=5 > articleIlvl+1 → subparagraph
    expect(levels[5]).toMatchObject({ ilvl: 5, tier: 'subparagraph' });
  });

  it('styleLadder includes PRT, ART from pStyle + PR1 from resolvedNumPr, sorted', () => {
    const ids = profile.styleLadder.map((e) => e.styleId);
    expect(ids).toEqual(['ART', 'PR1', 'PRT']);
  });

  it('ART entry → tier article', () => {
    const art = profile.styleLadder.find((e) => e.styleId === 'ART');
    expect(art).toEqual({ styleId: 'ART', numId: 2, ilvl: 3, tier: 'article' });
  });

  it('profile passes NumberingProfileSchema.parse (round-trip validity)', () => {
    expect(() => NumberingProfileSchema.parse(profile)).not.toThrow();
  });
});

describe('extractNumberingProfile — edge cases', () => {
  it('skips numId whose abstractNum is missing', () => {
    // KNOWN AMBIGUITY: when a Num references a non-existent abstractNumId,
    // we skip that numId entirely (emit nothing) rather than emitting { numId, levels: [] }.
    // Rationale: a ghost entry with no levels is indistinguishable from an empty numbering
    // definition and cannot be reconstructed by Task 5's applyNumberingProfile.
    const map: NumberingMap = {
      nums: new Map([
        [1, { numId: 1, abstractNumId: 0 }], // abstractNumId 0 exists
        [2, { numId: 2, abstractNumId: 99 }], // abstractNumId 99 does NOT exist
      ]),
      abstractNums: new Map([[0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal' }] }]]),
      pStyleToNumId: new Map(),
      pStyleToIlvl: new Map(),
      articleIlvl: 1,
      // numId 2 IS spec-shaped (passes the spec-shaped filter) but its abstractNum
      // is missing — so it must be the abstractNum guard, not the filter, that drops it.
      specShapedNumIds: new Set([1, 2]),
    };
    const styles: StyleMap = {
      styles: new Map(),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const profile = extractNumberingProfile(map, styles);
    expect(profile.numbering.map((n) => n.numId)).toEqual([1]);
  });

  it('emits only spec-shaped numIds — round-trips specShapedNumIds', () => {
    // A generic (non-spec-shaped) list numId with a valid abstractNum must NOT
    // appear in numbering: only the structural ladder belongs there. This makes
    // Task 5's reconstruction `new Set(numbering.map(n => n.numId))` exact.
    const map: NumberingMap = {
      nums: new Map([
        [1, { numId: 1, abstractNumId: 0 }], // spec-shaped
        [7, { numId: 7, abstractNumId: 5 }], // generic bullet list — NOT spec-shaped
      ]),
      abstractNums: new Map([
        [0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1' }] }],
        [5, { abstractNumId: 5, levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•' }] }],
      ]),
      pStyleToNumId: new Map(),
      pStyleToIlvl: new Map(),
      articleIlvl: 1,
      specShapedNumIds: new Set([1]),
    };
    const styles: StyleMap = {
      styles: new Map(),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const profile = extractNumberingProfile(map, styles);
    expect(profile.numbering.map((n) => n.numId)).toEqual([1]);
    // Round-trip: the set of emitted numIds equals the input specShapedNumIds
    expect(new Set(profile.numbering.map((n) => n.numId))).toEqual(map.specShapedNumIds);
  });

  it('style present in both pStyle maps and resolvedNumPr — pStyle entry wins (no duplicate)', () => {
    const map: NumberingMap = {
      nums: new Map([[1, { numId: 1, abstractNumId: 0 }]]),
      abstractNums: new Map([[0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal' }] }]]),
      pStyleToNumId: new Map([['MyStyle', 1]]),
      pStyleToIlvl: new Map([['MyStyle', 0]]),
      articleIlvl: 1,
      specShapedNumIds: new Set([1]),
    };
    const styles: StyleMap = {
      styles: new Map(),
      // resolvedNumPr has same style but different ilvl — pStyle wins
      resolvedNumPr: new Map([['MyStyle', { numId: 1, ilvl: 2 }]]),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const profile = extractNumberingProfile(map, styles);
    const entry = profile.styleLadder.find((e) => e.styleId === 'MyStyle');
    // pStyle entry wins: ilvl=0 from pStyleToIlvl (not ilvl=2 from resolvedNumPr)
    expect(entry).toEqual({ styleId: 'MyStyle', numId: 1, ilvl: 0, tier: 'part' });
    expect(profile.styleLadder.length).toBe(1);
  });
});
