import { describe, it, expect } from 'vitest';
import {
  applyNumberingProfile,
  mergeProfileConflicts,
  extractNumberingProfile,
} from './numbering-profile.js';
import { classifyParagraphs, buildTree } from './inference.js';
import { classifyWithOptionalProfile } from './index.js';
import type {
  ClassifiedParagraph,
  DocxParagraph,
  NumberingMap,
  SignalConflict,
  StyleMap,
} from './types.js';
import type { NumberingProfile } from '../../ast/index.js';

// ─── Shared fixtures ────────────────────────────────────────────────────────────

// The built-in 'CSI Default' the API injects for un-onboarded specs: empty
// numbering + empty styleLadder + no articleIlvl. MUST be a passthrough.
const CSI_DEFAULT: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

function makeBaseMap(): NumberingMap {
  return {
    nums: new Map([[1, { numId: 1, abstractNumId: 0 }]]),
    abstractNums: new Map([[0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal' }] }]]),
    pStyleToNumId: new Map([['P', 1]]),
    pStyleToIlvl: new Map([['P', 0]]),
    articleIlvl: 1,
    specShapedNumIds: new Set([1]),
  };
}

function emptyStyleMap(): StyleMap {
  return {
    styles: new Map(),
    resolvedNumPr: new Map(),
    resolvedJc: new Map(),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
  };
}

function para(p: Partial<DocxParagraph> & { text: string }): DocxParagraph {
  return { isVanish: false, ...p };
}

// ─── applyNumberingProfile — passthrough + immutability ──────────────────────────

describe('applyNumberingProfile — empty CSI default is a passthrough', () => {
  it('#299 empty profile returns a map deep-equal to base (no wipe)', () => {
    const base = makeBaseMap();
    const result = applyNumberingProfile(base, CSI_DEFAULT);
    expect(result).toEqual(base);
  });

  it('returns a NEW map object (immutable — never mutates base)', () => {
    const base = makeBaseMap();
    const result = applyNumberingProfile(base, CSI_DEFAULT);
    expect(result).not.toBe(base);
    expect(base).toEqual(makeBaseMap());
  });
});

// ─── applyNumberingProfile — field-by-field override ─────────────────────────────

describe('applyNumberingProfile — overrides only fields the profile specifies', () => {
  it('overrides articleIlvl when present; keeps base when absent', () => {
    const base = makeBaseMap();
    expect(applyNumberingProfile(base, { ...CSI_DEFAULT, articleIlvl: 3 }).articleIlvl).toBe(3);
    expect(applyNumberingProfile(base, CSI_DEFAULT).articleIlvl).toBe(1);
    expect(base.articleIlvl).toBe(1); // unmutated
  });

  it('rebuilds specShapedNumIds from numbering when non-empty; keeps base when empty', () => {
    const base = makeBaseMap();
    const withNumbering = applyNumberingProfile(base, {
      ...CSI_DEFAULT,
      numbering: [{ numId: 42, levels: [] }],
    });
    expect(withNumbering.specShapedNumIds).toEqual(new Set([42]));
    expect(applyNumberingProfile(base, CSI_DEFAULT).specShapedNumIds).toEqual(new Set([1]));
  });

  it('rebuilds pStyle maps from styleLadder when non-empty; keeps base when empty', () => {
    const base = makeBaseMap();
    const withLadder = applyNumberingProfile(base, {
      ...CSI_DEFAULT,
      styleLadder: [
        { styleId: 'X', numId: 5, ilvl: 0, tier: 'part' },
        { styleId: 'Y', numId: 5, ilvl: 1, tier: 'article' },
      ],
    });
    expect(withLadder.pStyleToNumId).toEqual(
      new Map([
        ['X', 5],
        ['Y', 5],
      ])
    );
    expect(withLadder.pStyleToIlvl).toEqual(
      new Map([
        ['X', 0],
        ['Y', 1],
      ])
    );
    expect(applyNumberingProfile(base, CSI_DEFAULT).pStyleToNumId).toEqual(new Map([['P', 1]]));
  });

  it('always keeps base nums/abstractNums (profile cannot rebuild them)', () => {
    const base = makeBaseMap();
    const result = applyNumberingProfile(base, { ...CSI_DEFAULT, articleIlvl: 4 });
    expect(result.nums).toBe(base.nums);
    expect(result.abstractNums).toBe(base.abstractNums);
  });
});

// ─── INV3: override is deterministic (drives classifyParagraphs tier boundaries) ──

describe('#299 INV3 — profile override deterministically shifts classification', () => {
  it('articleIlvl override moves the same paragraph from pr2 → article', () => {
    const base: NumberingMap = { ...makeBaseMap(), articleIlvl: 1 };
    const p = [para({ text: 'Materials and equipment description', numId: 1, ilvl: 3 })];

    const baseClass = classifyParagraphs(p, base, emptyStyleMap());
    expect(baseClass[0]?.nodeType).toBe('pr2'); // ilvl 3, articleIlvl 1 → offset 2 → pr2

    const overridden = applyNumberingProfile(base, { ...CSI_DEFAULT, articleIlvl: 3 });
    const profClass = classifyParagraphs(p, overridden, emptyStyleMap());
    expect(profClass[0]?.nodeType).toBe('article'); // ilvl 3 == articleIlvl 3 → article
  });

  it('specShapedNumIds override accepts an ilvl=0 paragraph as part', () => {
    const base: NumberingMap = { ...makeBaseMap(), specShapedNumIds: new Set() };
    const p = [para({ text: 'Submittals procedures', numId: 1, ilvl: 0 })];

    const baseClass = classifyParagraphs(p, base, emptyStyleMap());
    expect(baseClass[0]?.nodeType).toBe('continuation'); // ilvl=0 part rejected (not spec-shaped)

    const overridden = applyNumberingProfile(base, {
      ...CSI_DEFAULT,
      numbering: [{ numId: 1, levels: [] }],
    });
    const profClass = classifyParagraphs(p, overridden, emptyStyleMap());
    expect(profClass[0]?.nodeType).toBe('part'); // numId 1 now spec-shaped → part accepted
  });
});

// ─── INV4: profile-vs-inference disagreements are persisted, never dropped ────────

function cp(
  nodeType: ClassifiedParagraph['nodeType'],
  resolvedIlvl: number,
  signalUsed: ClassifiedParagraph['signalUsed'],
  conflicts: readonly SignalConflict[] = [],
  suppressed?: boolean
): ClassifiedParagraph {
  return {
    paragraph: para({ text: 'x' }),
    resolvedIlvl,
    nodeType,
    signalUsed,
    conflicts,
    agreed: [],
    isVanish: false,
    ...(suppressed !== undefined ? { suppressed } : {}),
  };
}

describe('#299 INV4 — mergeProfileConflicts records the losing base classification', () => {
  it('appends the base result as a conflict where nodeType differs', () => {
    const withProfile = [cp('article', 1, 1), cp('pr1', 2, 2)];
    const base = [cp('pr2', 3, 1), cp('pr1', 2, 2)];
    const merged = mergeProfileConflicts(withProfile, base);

    expect(merged[0]?.nodeType).toBe('article'); // authoritative (profile) wins
    expect(merged[0]?.conflicts).toEqual([{ signal: 1, reportedIlvl: 3, reportedNodeType: 'pr2' }]);
  });

  it('leaves agreeing paragraphs untouched (same reference)', () => {
    const withProfile = [cp('article', 1, 1), cp('pr1', 2, 2)];
    const base = [cp('pr2', 3, 1), cp('pr1', 2, 2)];
    const merged = mergeProfileConflicts(withProfile, base);
    expect(merged[1]).toBe(withProfile[1]);
  });

  it('records a conflict when only resolvedIlvl differs (same nodeType)', () => {
    const withProfile = [cp('continuation', 1, 3)];
    const base = [cp('continuation', 4, 3)];
    const merged = mergeProfileConflicts(withProfile, base);
    expect(merged[0]?.conflicts).toEqual([
      { signal: 3, reportedIlvl: 4, reportedNodeType: 'continuation' },
    ]);
  });

  it('preserves pre-existing conflicts (append, never replace)', () => {
    const existing: SignalConflict = { signal: 5, reportedIlvl: 9, reportedNodeType: 'pr7' };
    const withProfile = [cp('article', 1, 1, [existing])];
    const base = [cp('pr2', 3, 2)];
    const merged = mergeProfileConflicts(withProfile, base);
    expect(merged[0]?.conflicts).toEqual([
      existing,
      { signal: 2, reportedIlvl: 3, reportedNodeType: 'pr2' },
    ]);
  });
});

// ─── #292 — mergeProfileConflicts preserves suppressed on both paths ─────────────

describe('#292 mergeProfileConflicts preserves the suppressed field unchanged', () => {
  it('equal-reference path: agreeing paragraphs return the same object, suppressed carries through', () => {
    const withProfile = [cp('pr2', 3, 1, [], true)];
    const base = [cp('pr2', 3, 1, [], true)]; // same nodeType/resolvedIlvl → no conflict
    const merged = mergeProfileConflicts(withProfile, base);
    expect(merged[0]).toBe(withProfile[0]); // untouched — same reference
    expect(merged[0]?.suppressed).toBe(true);
  });

  it('conflict-append path: suppressed:true survives the { ...cp } spread when nodeType/ilvl differ', () => {
    const withProfile = [cp('article', 1, 1, [], true)];
    const base = [cp('pr2', 3, 2)];
    const merged = mergeProfileConflicts(withProfile, base);
    expect(merged[0]).not.toBe(withProfile[0]); // new object — conflict was appended
    expect(merged[0]?.suppressed).toBe(true);
    expect(merged[0]?.conflicts).toEqual([{ signal: 2, reportedIlvl: 3, reportedNodeType: 'pr2' }]);
  });
});

// ─── #317: style-inherited conflicts survive the profile override ────────────────

// One style-inherited paragraph (w:pStyle, NO own w:numPr) — numId/ilvl come from
// the map at parse time, which is exactly the path the base reparse must protect.
function docXmlWithStyledPara(styleId: string, text: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>` +
    `</w:body></w:document>`
  );
}

describe('#317 classifyWithOptionalProfile — style-inherited conflict is recorded, not dropped', () => {
  it('records the losing base inference when a styleLadder override remaps a style-inherited paragraph', () => {
    // Base: style H inherits numId 1 at ilvl 3 → with articleIlvl 1, offset 2 → pr2.
    const base: NumberingMap = {
      nums: new Map([
        [1, { numId: 1, abstractNumId: 0 }],
        [2, { numId: 2, abstractNumId: 0 }],
      ]),
      abstractNums: new Map([[0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal' }] }]]),
      pStyleToNumId: new Map([['H', 1]]),
      pStyleToIlvl: new Map([['H', 3]]),
      articleIlvl: 1,
      specShapedNumIds: new Set([1, 2]),
    };
    // Profile remaps style H to numId 2 at ilvl 1 → article (spec-shaped via base set).
    const profile: NumberingProfile = {
      tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
      numbering: [],
      styleLadder: [{ styleId: 'H', numId: 2, ilvl: 1, tier: 'article' }],
    };
    const xml = docXmlWithStyledPara('H', 'Submittals and quality assurance');

    const merged = classifyWithOptionalProfile(xml, base, emptyStyleMap(), new Map(), profile);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.nodeType).toBe('article'); // profile wins (authoritative)
    // The losing un-profiled inference (pr2) MUST be recorded. Before the base
    // reparse, the base path reused the overridden-baked numbering, classified the
    // paragraph as 'article' too, and dropped this conflict entirely.
    expect(merged[0]?.conflicts).toHaveLength(1);
    expect(merged[0]?.conflicts[0]?.reportedNodeType).toBe('pr2');
  });
});

// ─── #317: continuation/note nodes preserve profile-vs-inference conflicts ────────

describe('#317 makeContinuationNode — a demoted continuation keeps its conflicts in meta', () => {
  it('serializes conflicts on a continuation node (not just structural makeNode nodes)', () => {
    // A profile can demote a paragraph to 'continuation' while the un-profiled base
    // inference disagreed (here: base said 'article'). buildTree must persist that
    // losing signal via meta.conflicts — makeContinuationNode historically dropped it.
    const partCp = cp('part', 0, 1);
    const contCp = cp('continuation', 1, 2, [
      { signal: 1, reportedIlvl: 1, reportedNodeType: 'article' },
    ]);
    const tree = buildTree([partCp, contCp], '21 11 00', 'T', 'arcat');

    const child = tree.parts[0]?.children[0];
    expect(child?.type).toBe('continuation');
    expect(child?.meta.conflicts).toEqual([
      { signal: 1, reportedIlvl: 1, reportedNodeType: 'article' },
    ]);
  });
});

// ─── #317 / #319: profile `tier` is derived from ilvl, not independently authoritative ─

describe('#317 KNOWN AMBIGUITY — profile `tier` is derived from ilvl, not authoritative', () => {
  // KNOWN AMBIGUITY (#319): a styleLadder/numbering `tier` field is written by the
  // extractor (tierForIlvl) and NOT read on apply — classification derives the node
  // type from ilvl + articleIlvl. A manually-edited `tier` that disagrees with its
  // `ilvl` is therefore a silent no-op. The design doc calls the profile
  // "authoritative for the numId→tier mapping"; today that authority flows through
  // ilvl+articleIlvl. Making `tier` independently authoritative is deferred to #319.
  it('a styleLadder entry with tier=article but ilvl=3 classifies by ilvl (→ pr2), not the declared tier', () => {
    const base: NumberingMap = {
      nums: new Map([[1, { numId: 1, abstractNumId: 0 }]]),
      abstractNums: new Map([[0, { abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'decimal' }] }]]),
      pStyleToNumId: new Map(),
      pStyleToIlvl: new Map(),
      articleIlvl: 1,
      specShapedNumIds: new Set([1]),
    };
    const profile: NumberingProfile = {
      tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
      numbering: [],
      styleLadder: [{ styleId: 'H', numId: 1, ilvl: 3, tier: 'article' }],
    };
    const xml = docXmlWithStyledPara('H', 'Materials');
    const merged = classifyWithOptionalProfile(xml, base, emptyStyleMap(), new Map(), profile);
    // ilvl 3 with articleIlvl 1 → offset 2 → pr2; the declared tier:'article' is ignored.
    expect(merged[0]?.nodeType).toBe('pr2');
  });
});

// ─── Round-trip: applyNumberingProfile ∘ extractNumberingProfile ──────────────────

describe('#299 round-trip — apply(extract(map)) reproduces classification fields', () => {
  // resolvedNumPr empty so the styleLadder is exactly the pStyle maps (no union
  // superset) — the precondition for an EXACT round-trip of the four fields.
  function roundTripMap(): NumberingMap {
    return {
      nums: new Map([[1, { numId: 1, abstractNumId: 0 }]]),
      abstractNums: new Map([
        [
          0,
          {
            abstractNumId: 0,
            levels: [
              { ilvl: 0, numFmt: 'decimal', lvlText: 'PART %1', pStyle: 'P_Part' },
              { ilvl: 1, numFmt: 'decimal', pStyle: 'P_Article' },
              { ilvl: 2, numFmt: 'upperLetter', pStyle: 'P_Pr1' },
            ],
          },
        ],
      ]),
      pStyleToNumId: new Map([
        ['P_Part', 1],
        ['P_Article', 1],
        ['P_Pr1', 1],
      ]),
      pStyleToIlvl: new Map([
        ['P_Part', 0],
        ['P_Article', 1],
        ['P_Pr1', 2],
      ]),
      articleIlvl: 1,
      specShapedNumIds: new Set([1]),
    };
  }

  it('reproduces articleIlvl, specShapedNumIds, pStyleToNumId, pStyleToIlvl', () => {
    const map = roundTripMap();
    const profile = extractNumberingProfile(map, emptyStyleMap());
    const rebuilt = applyNumberingProfile(map, profile);

    expect(rebuilt.articleIlvl).toBe(map.articleIlvl);
    expect(rebuilt.specShapedNumIds).toEqual(map.specShapedNumIds);
    expect(rebuilt.pStyleToNumId).toEqual(map.pStyleToNumId);
    expect(rebuilt.pStyleToIlvl).toEqual(map.pStyleToIlvl);
  });
});
