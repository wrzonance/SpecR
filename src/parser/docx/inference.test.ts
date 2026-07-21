import { describe, it, expect } from 'vitest';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { ClassifiedParagraph, DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { NodeType, SpecNode } from '../../ast/types.js';

function emptyStyleMap(): StyleMap {
  return {
    styles: new Map(),
    resolvedNumPr: new Map(),
    resolvedJc: new Map(),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
  };
}

function makePara(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text: '', isVanish: false, ...overrides };
}

const numMap = (articleIlvl = 1): NumberingMap => ({ ...emptyNumberingMap(), articleIlvl });

describe('classifyParagraphs — signal 1 (numId+ilvl)', () => {
  it('articleIlvl=1 ilvl=0 → part, normalizedIlvl=0', () => {
    // Signal 1 requires PART heading text when ilvl=0 — prevents <ol> list items
    // (also numId > 0 at ilvl=0 in LibreOffice) from being misclassified as PART nodes.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, text: 'PART 1 – GENERAL' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.resolvedIlvl).toBe(0);
  });

  it('ilvl=3 → article when articleIlvl=3, normalizedIlvl=1', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 3 })],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.resolvedIlvl).toBe(1);
    expect(result[0]?.signalUsed).toBe(1);
  });

  it('ilvl=0 without PART text does NOT claim part — LibreOffice ol regression', () => {
    // Regression: LibreOffice exports <ol><li> with numId > 0 at ilvl=0.
    // Without the PART text guard, Signal 1 would misclassify these as 'part'.
    // "All work shall comply..." has no PART pattern → falls through to continuation.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, text: 'All work shall comply with applicable standards.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).not.toBe('part');
  });

  it('numId=0 does NOT fire (OOXML suppress sentinel) — falls through to signal 4', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 0, ilvl: 2, text: 'A. text here' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(4);
    expect(result[0]?.nodeType).toBe('pr1');
  });

  it('articleIlvl=1 ilvl=7 and ilvl=8 map to pr6/pr7 before Word depth cap', () => {
    const result = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 7, text: 'Nested option' }),
        makePara({ numId: 1, ilvl: 8, text: 'Nested sub-option' }),
        makePara({ numId: 1, ilvl: 9, text: 'Past Word depth' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(result.map((r) => r.nodeType)).toEqual(['pr6', 'pr7', 'continuation']);
    expect(result.map((r) => r.resolvedIlvl)).toEqual([7, 8, 8]);
  });
});

describe('classifyParagraphs — signal 2 (style resolvedNumPr)', () => {
  it('classifies via style resolvedNumPr', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading1', { styleId: 'Heading1', name: 'heading 1' }]]),
      resolvedNumPr: new Map([['Heading1', { numId: 1, ilvl: 0 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'Heading1', text: 'PART 1' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(2);
  });

  it('suppressesNumbering style does NOT fire signal 2', () => {
    const styleMap: StyleMap = {
      styles: new Map([['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', suppressesNumbering: true }]]),
      resolvedNumPr: new Map([['PR1lc', { numId: 1, ilvl: 4 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR1lc', text: 'Continuation text here.' })],
      numMap(3),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('numId=0 override suppresses style numbering — SPECText1 [OR] separator is not a part (08 14 16)', () => {
    // Regression (more-broken-parsing.docx, 08 14 16): decorative "****** [OR] ******"
    // separators keep the PART style (SPECText1 → ilvl 0) but set <w:numId w:val="0"/>
    // to REMOVE numbering. Signal 1 already bails on numId=0; Signal 2 read the STYLE's
    // resolvedNumPr and ignored the paragraph's opt-out, promoting them to spurious PART
    // nodes that split PRODUCTS/EXECUTION → 5 parts. An explicit numId=0 (OOXML's
    // "remove numbering" sentinel) must suppress style-derived numbering exactly as it
    // suppresses direct numbering — the paragraph is not a numbered structural node.
    const styleMap: StyleMap = {
      styles: new Map([['SPECText1', { styleId: 'SPECText1', name: 'SPEC Text 1' }]]),
      resolvedNumPr: new Map([['SPECText1', { numId: 2, ilvl: 0 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'SPECText1', numId: 0, ilvl: 0, text: '****** [OR] ******' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).not.toBe('part');
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  // #292: isRuleRow requires >=5 bare asterisks and nothing else, so "****** [OR]
  // ******" is deliberately OUTSIDE its scope (it carries "[OR]" text, not a pure
  // asterisk run) — it stays on this existing isDecorationSeparator path, unsuppressed,
  // exactly as asserted above and below.
  it("#292: a 4-asterisk run is below isRuleRow's 5-asterisk minimum — stays on the decoration path, unsuppressed", () => {
    const result = classifyParagraphs([makePara({ text: '****' })], numMap(1), emptyStyleMap());
    expect(result[0]?.suppressed).not.toBe(true);
    expect(result[0]?.isNote).not.toBe(true);
    expect(result[0]?.nodeType).toBe('continuation');
  });

  it('decoration separator with a LIVE-numbered part style is still not a part (defense-in-depth)', () => {
    // The numId=0 guard catches DE-numbered separators, but a separator that kept BOTH
    // a part-tier style AND live numbering (numId != 0) would resurrect as a spurious
    // PART via Signal 2. A pure "[OR]" / asterisk-rule line is editorial decoration,
    // never a structural node — gate it to a continuation before any signal runs.
    const styleMap: StyleMap = {
      styles: new Map([['SPECText1', { styleId: 'SPECText1', name: 'SPEC Text 1' }]]),
      resolvedNumPr: new Map([['SPECText1', { numId: 2, ilvl: 0 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'SPECText1', numId: 2, ilvl: 0, text: '****** [OR] ******' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('numId=0 does not block Signal 4 — a de-numbered article style still reads its text tier', () => {
    // Guard the guard: suppressing Signal 2 on numId=0 must not swallow a paragraph
    // that carries a literal "N.N" tier. A SPECText1 paragraph with numId=0 whose text
    // is "1.1 SUMMARY" is still an article via Signal 4 (text), not a continuation.
    const styleMap: StyleMap = {
      styles: new Map([['SPECText1', { styleId: 'SPECText1', name: 'SPEC Text 1' }]]),
      resolvedNumPr: new Map([['SPECText1', { numId: 2, ilvl: 0 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'SPECText1', numId: 0, text: '1.1 SUMMARY' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(4);
  });

  it('numId=undefined still inherits style numbering (Signal 2 unaffected by the numId=0 guard)', () => {
    // A paragraph with NO direct numPr (numId undefined) must still fire Signal 2 from
    // its style — only an explicit numId=0 opt-out suppresses it.
    const styleMap: StyleMap = {
      styles: new Map([['SPECText1', { styleId: 'SPECText1', name: 'SPEC Text 1' }]]),
      resolvedNumPr: new Map([['SPECText1', { numId: 2, ilvl: 0 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'SPECText1', text: 'GENERAL' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(2);
  });

  it('signal 1 wins over signal 2; conflict logged', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading2', { styleId: 'Heading2', name: 'heading 2' }]]),
      resolvedNumPr: new Map([['Heading2', { numId: 1, ilvl: 1 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 2, styleId: 'Heading2' })],
      numMap(1),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('pr1');
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.conflicts).toHaveLength(1);
    expect(result[0]?.conflicts[0]?.signal).toBe(2);
    expect(result[0]?.conflicts[0]?.reportedNodeType).toBe('article');
  });
});

describe('classifyParagraphs — signals 4, 5, and fallback', () => {
  it('signal 4: classifies via text regex when signals 1+2 absent', () => {
    const result = classifyParagraphs(
      [makePara({ text: 'A. First paragraph of content' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('pr1');
    expect(result[0]?.signalUsed).toBe(4);
  });

  // Regression (tab-delimited manual outline): a hand-authored article uses a TAB
  // between the typed number and the title ("1.1<tab>SUMMARY"), the only delimiter.
  // The Signal-4 patterns require \s after the number — a tab is \s, so the article is
  // recognized. This pins the paired fix in text extraction (source-facts.ts / document.ts):
  // when the tab was dropped, text became "1.1SUMMARY" and this fell through to a wrong
  // signal. Article via Signal 4 is what lets its outline label strip downstream.
  it('signal 4: a tab-delimited manual outline "1.1\\tSUMMARY" classifies as article', () => {
    const result = classifyParagraphs(
      [makePara({ text: '1.1\tSUMMARY' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(4);
  });

  it('signal 5: classifies via indentation when signals 1+2+4 absent', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 576, text: 'Lorem ipsum dolor sit amet.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(5);
  });

  // Regression (centered-title junk root): a centered heading ("SECTION 26 0513.01",
  // the section title) carries a large SYMMETRIC w:ind (centering padding), not outline
  // depth. Signal 5 rounded 3859/576 ≈ 7 → pr6, making the section header a spurious
  // deep-pr root that inflated the part ordinal downstream (article labels rendered
  // "3.1" instead of "1.1" and never stripped). A centered/right-aligned paragraph is
  // never a hierarchy node, so indentation must not fire for it.
  it('signal 5: a CENTERED paragraph indent is positioning, not a level (no pr node)', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 3859, jc: 'center', text: 'SECTION 26 0513.01' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('signal 5: a RIGHT-aligned paragraph indent is positioning, not a level', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 1728, jc: 'right', text: 'Right aligned footer-ish line.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  // A JUSTIFIED (both) paragraph is normal flow — its indent IS meaningful, so Signal 5
  // must still fire (only center/right positioning is excluded).
  it('signal 5: a JUSTIFIED (both) paragraph still classifies from indentation', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 576, jc: 'both', text: 'Justified body paragraph text.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(5);
  });

  it('indent alone never creates a PART — negative-indent "SUMMARY OF CHANGE(S):" preamble (08 14 16)', () => {
    // Regression (08 1416 Flush Wood Doors.docx): a preamble line "SUMMARY OF
    // CHANGE(S):" with a slight NEGATIVE left indent (-86 twips), no numbering, no
    // style, not hidden. Signal 5 rounded -86/576 → -0 → ilvl 0 → 'part', inventing a
    // phantom PART 1 that pushed GENERAL/PRODUCTS/EXECUTION to PART 2/3/4. Indentation
    // is the weakest signal and must never establish a PART (the top tier needs real
    // evidence: numbering, "PART n" text, or a part style) — so a paragraph whose only
    // signal is a ≈0/negative indent falls through to continuation.
    const result = classifyParagraphs(
      [makePara({ leftIndent: -86, text: 'SUMMARY OF CHANGE(S):' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).not.toBe('part');
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('indent alone never creates a PART — a plain unindented (0) paragraph is not a part', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 0, text: 'Some unindented preamble line.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).not.toBe('part');
    expect(result[0]?.nodeType).toBe('continuation');
  });

  it('signal 5 still classifies article-and-deeper from indentation (article unaffected)', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 576, text: 'Lorem ipsum dolor sit amet consectetur.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(5);
  });

  it('continuation: no signal fires → nodeType continuation, signalUsed 3', () => {
    const result = classifyParagraphs(
      [makePara({ text: 'Some plain paragraph text.' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.signalUsed).toBe(3);
  });

  it('vanish paragraph: isVanish propagated and classified as continuation', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, isVanish: true, text: 'PART 1 – GENERAL' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.isVanish).toBe(true);
    expect(result[0]?.nodeType).toBe('continuation');
  });
});

describe('classifyParagraphs — reserved-low-level (articleIlvl=3) regressions', () => {
  it('PR1lc suppressesNumbering → continuation not pr1', () => {
    // An explicit numId=0 opt-out (suppressesNumbering) is an author decision to
    // de-number this paragraph — it stays a continuation even though its name looks
    // like a lead-in. This is distinct from the real-file case below (no opt-out).
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR1', { styleId: 'PR1', name: 'PR1' }],
        ['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', suppressesNumbering: true, basedOn: 'PR1' }],
      ]),
      resolvedNumPr: new Map([['PR1', { numId: 2, ilvl: 4 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR1lc', text: 'This continues the paragraph above.' })],
      numMap(3),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('continuation');
  });

  // Regression (reserved-low-level fixtures): the real
  // lead-in styles PR1lc..PR5lc have NEITHER numbering NOR a numId=0 opt-out — they are
  // unnumbered lead-ins ("Section Includes:", "Related Requirements:") that introduce a
  // numbered PR2 list. Left as continuations they orphan those PR2 items at the article
  // tier (a level gap: pr2 directly under article). A lead-in must occupy its base PRn
  // tier so the list nests under it. The tier is derived from the base PRn style.
  it('PR1lc lead-in (no numbering, not suppressed) → pr1 tier from base PR1', () => {
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR1', { styleId: 'PR1', name: 'PR1' }],
        ['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', next: 'PR1' }],
      ]),
      resolvedNumPr: new Map([['PR1', { numId: 1, ilvl: 4 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR1lc', text: 'Section Includes:' })],
      numMap(3), // articleIlvl = 3 (low levels reserved)
      styleMap
    );
    expect(result[0]?.nodeType).toBe('pr1');
    expect(result[0]?.signalUsed).toBe(2);
  });

  it('PR2lc lead-in → pr2 tier from base PR2', () => {
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR2', { styleId: 'PR2', name: 'PR2' }],
        ['PR2lc', { styleId: 'PR2lc', name: 'PR2lc', next: 'PR2' }],
      ]),
      resolvedNumPr: new Map([['PR2', { numId: 1, ilvl: 5 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR2lc', text: 'Related Requirements:' })],
      numMap(3),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('pr2');
  });

  it('a PRnlc lead-in whose base style has no resolved numbering stays a continuation', () => {
    const styleMap: StyleMap = {
      styles: new Map([['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', next: 'PR1' }]]),
      resolvedNumPr: new Map(), // no base PR1 numbering to inherit
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR1lc', text: 'Section Includes:' })],
      numMap(3),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('continuation');
  });
});

describe('classifyParagraphs — misaligned-numbering article guard', () => {
  // Regression (parsing-needs-fixing.docx PART 3): hand-authored manufacturer docs
  // reuse numIds with inconsistent ilvl baselines. A nested list item ("1. Normal
  // street clothes…", numId 13, ilvl 3, indent 2160) resolved to 'article' via the
  // global articleIlvl=3 — becoming a spurious top-level 3.x that corrupts sibling
  // numbering. Its indentation (2160 twips → pr-tier) contradicts the article claim
  // by ≥2 tiers, so indentation wins and it nests as a pr node instead.
  it('demotes a Signal-1 "article" whose indentation is ≥2 tiers deeper', () => {
    const result = classifyParagraphs(
      [
        makePara({
          numId: 13,
          ilvl: 3,
          leftIndent: 2160,
          text: 'Normal street clothes may be worn',
        }),
      ],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).not.toBe('article');
    expect(result[0]?.signalUsed).toBe(5); // indentation wins (no text signal present)
    // the discarded Signal-1 article is persisted as a conflict, never dropped
    expect(
      result[0]?.conflicts.some((c) => c.signal === 1 && c.reportedNodeType === 'article')
    ).toBe(true);
  });

  // Codex review: when demoting a bogus article, honor signal precedence — a literal
  // "1." text tier (Signal 4 → pr2) outranks the raw twips estimate (Signal 5 → pr3).
  it('demotes to the highest-priority remaining signal (text tier beats indent twips)', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 13, ilvl: 3, leftIndent: 2160, text: '1. Normal street clothes' })],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('pr2'); // from Signal 4 text, not pr3 from indent
    expect(result[0]?.signalUsed).toBe(4);
  });

  it('keeps a Signal-1 article when indentation agrees within 1 tier (real article ≈900 twips)', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 3, leftIndent: 900, text: 'SUMMARY' })],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(1);
  });

  it('keeps a Signal-1 article when there is no indentation evidence', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 3 })],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(1);
  });

  // Codex review hardening: a deep indent must NOT override an article when a literal
  // "N.N" text prefix (Signal 4) independently corroborates it. Only an article with
  // no other non-indent corroboration is treated as a misaligned-numbering artifact.
  it('keeps an article when a literal "N.N" text signal corroborates, despite deep indent', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 3, leftIndent: 2160, text: '1.1 SUMMARY OF WORK' })],
      numMap(3),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.signalUsed).toBe(1);
  });
});

function makeClassified(
  nodeType: NodeType,
  normalizedIlvl: number,
  text = '',
  isVanish = false
): ClassifiedParagraph {
  return {
    paragraph: { text, isVanish },
    resolvedIlvl: normalizedIlvl,
    nodeType,
    signalUsed: 1,
    conflicts: [],
    agreed: [],
    isVanish,
  };
}

describe('buildTree — Pass 2: tree structure', () => {
  it('builds single part node as root', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01 10 00', 'Title', 'arcat');
    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.type).toBe('part');
    expect(tree.parts[0]?.text).toBe('PART 1');
    expect(tree.section).toBe('01 10 00');
    expect(tree.title).toBe('Title');
  });

  it('nests article under part', () => {
    const classified = [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1')];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.type).toBe('article');
  });

  it('nests pr1 under article under part', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.children[0]?.type).toBe('pr1');
  });

  it('handles multiple parts at root', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('part', 0, 'PART 2'),
      makeClassified('part', 0, 'PART 3'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts).toHaveLength(3);
  });

  // Regression (a hand-authored doc): a PART heading whose literal run
  // text bakes in the render-derived "PART n -" prefix (PART 1/2 came bare from
  // numbering, but PART 3's text was literally "PART 3 - EXECUTION"). Without
  // stripping, the renderer's own getLabel prefix doubles it to the garbled
  // "PART 3 - PART 3 - EXECUTION". The AST must store only the part name.
  it('strips a baked-in "PART n -" prefix from part-node text', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 3 - EXECUTION')], '01', 'T', 'cpi');
    expect(tree.parts[0]?.text).toBe('EXECUTION');
  });

  it('leaves a bare-name part heading (numbering-supplied prefix) untouched', () => {
    const tree = buildTree([makeClassified('part', 0, 'GENERAL')], '01', 'T', 'cpi');
    expect(tree.parts[0]?.text).toBe('GENERAL');
  });

  it('keeps the original when stripping a bare "PART n" would empty the text', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01', 'T', 'arcat');
    expect(tree.parts[0]?.text).toBe('PART 1');
  });

  // Label-match strip (Codex adversarial review resolution): the typed number on an
  // article is stripped ONLY when it equals the article's own sibling-derived CSI label,
  // so a decimal MEASUREMENT that merely opens the text keeps its number verbatim. Here
  // "2.0 inches …" sits at the first article (label "1.1"), so "2.0" ≠ "1.1" → preserved.
  it('preserves decimal measurement text — its number is not the article label', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '2.0 inches of clearance minimum' }),
      ],
      numMap(),
      emptyStyleMap()
    );
    expect(classified[1]?.signalUsed).toBe(4);
    const tree = buildTree(classified, '01', 'T', 'unknown');
    expect(tree.parts[0]?.children[0]?.text).toBe('2.0 inches of clearance minimum');
  });

  // The user's day-1 requirement: countless specs carry "2.1 GHz", "1.5 MHz",
  // "N.N <unit>" measurement lines, and SpecR must not mangle them. The old text-only
  // [A-Z] strip dropped "2.0" from "2.0 GHz" (the capital G looked like a heading).
  // Label-match fixes it: at the first article the label is "1.1" ≠ "2.0", so the whole
  // measurement is preserved. No unit list, no data loss.
  it('preserves a capital-unit measurement ("2.0 GHz …") — number ≠ label (no data loss)', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '2.0 GHz frequency band' }),
        makePara({ text: '1.5 MHz reference clock' }),
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const kids = tree.parts[0]?.children ?? [];
    expect(kids[0]?.text).toBe('2.0 GHz frequency band'); // label 1.1 ≠ 2.0 → kept
    expect(kids[1]?.text).toBe('1.5 MHz reference clock'); // label 1.2 ≠ 1.5 → kept
  });

  // A real single-dot outline heading IS stripped — at the position where its typed
  // number equals its label AND the title reads like a heading (ALL-CAPS or Title-Case,
  // i.e. an uppercase first letter). Sequentially-numbered articles ("1.1 …", "1.2 …")
  // land on matching labels and lose their duplicate number.
  it('strips the typed number from uppercase-titled articles at their labeled position', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 SUMMARY' }), // ord 0 → label 1.1, ALL-CAPS → strip
        makePara({ text: '1.2 RELATED SECTIONS' }), // ord 1 → label 1.2, ALL-CAPS → strip
        makePara({ text: '1.3 Related Sections' }), // ord 2 → label 1.3, Title-Case → strip
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const kids = tree.parts[0]?.children ?? [];
    expect(kids.map((c) => c.text)).toEqual(['SUMMARY', 'RELATED SECTIONS', 'Related Sections']);
  });

  // Codex adversarial review (P2 data-loss): a title that opens with a lowercase word or
  // a digit is indistinguishable from a measurement/prose value that merely coincides
  // with its label ("1.3 600 V …" ≈ "1.3 600 volts …"; "1.4 related …" ≈ "1.4 relative
  // humidity …"). Position alone cannot tell them apart, so the strip is withheld and the
  // text kept verbatim — no data loss. A genuine lowercase/numeric heading (vanishingly
  // rare; none in the corpus) merely renders its label doubled, which is recoverable.
  it('does NOT strip a digit- or lowercase-leading title (ambiguous with a value)', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 600 V power feed' }), // ord 0 → label 1.1, digit title → keep
        makePara({ text: '1.2 relative humidity range' }), // ord 1 → label 1.2, lowercase → keep
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const kids = tree.parts[0]?.children ?? [];
    expect(kids.map((c) => c.text)).toEqual([
      '1.1 600 V power feed',
      '1.2 relative humidity range',
    ]);
  });

  // A misnumbered/misplaced heading is NOT stripped (its typed number is not its
  // position's label) — the safe outcome: keep the text verbatim rather than guess.
  it('does NOT strip a number that is not the article label at its position', () => {
    const classified = classifyParagraphs(
      [makePara({ text: 'PART 1 - GENERAL' }), makePara({ text: '1.9 RELATED SECTIONS' })],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    // first article's label is "1.1"; typed "1.9" ≠ label → kept verbatim
    expect(tree.parts[0]?.children[0]?.text).toBe('1.9 RELATED SECTIONS');
  });

  // The same label-match strip extends BELOW the article tier: a hand-authored
  // manufacturer list types its pr-label ("A. General Cable"), which the renderer's own
  // getLabel re-prepends, doubling to "A. A. General Cable". Strip the typed label when it
  // equals the pr node's sibling-derived CSI label ("A." at ord 0), mirroring the article
  // rule. Only Signal-4 (manual text-outline) pr nodes are eligible.
  it('strips a manual pr-label when it equals the computed label ("A. General" → "General")', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 ACCEPTABLE MANUFACTURERS' }),
        makePara({ text: 'A. General Cable' }), // pr1 ord 0 → label "A." → strip
        makePara({ text: 'B. Okonite Company' }), // pr1 ord 1 → label "B." → strip
      ],
      numMap(),
      emptyStyleMap()
    );
    expect(classified[2]?.signalUsed).toBe(4);
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const article = tree.parts[0]?.children[0];
    expect(article?.children.map((c) => c.text)).toEqual(['General Cable', 'Okonite Company']);
  });

  it('rebases emphasis facts when stripping a matching manual pr-label', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 INSTALLATION' }),
        makePara({
          text: 'A. Install anchors',
          sourceFacts: {
            emphasis: [
              {
                property: 'bold',
                value: true,
                expected: false,
                text: 'anchors',
                span: [11, 18],
              },
            ],
          },
        }),
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const item = tree.parts[0]?.children[0]?.children[0];

    expect(item?.text).toBe('Install anchors');
    expect(item?.meta.sourceFacts?.emphasis?.[0]).toMatchObject({
      text: 'anchors',
      span: [8, 15],
    });
  });

  // Multi-tier: a numbered sub-list ("1. Authority …") that genuinely sits at its typed
  // position ("1." at ord 0) loses its duplicate; the position must match the CSI label.
  it('strips manual pr2 numeric labels at their matching position ("1. Authority" → "Authority")', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 DEFINITIONS' }),
        makePara({ text: '1. Authority having jurisdiction' }), // pr2 ord 0 → label "1." → strip
        makePara({ text: '2. Ethylene-propylene rubber' }), // pr2 ord 1 → label "2." → strip
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const article = tree.parts[0]?.children[0];
    expect(article?.children.map((c) => c.text)).toEqual([
      'Authority having jurisdiction',
      'Ethylene-propylene rubber',
    ]);
  });

  // Codex PR #432: a pr item's content often starts lowercase/numeric ("1. clean the
  // surface", "a. install anchors"). The article-only uppercase guard would leave the
  // matching label un-stripped and doubled; pr items strip on label-equality alone.
  it('strips a manual pr-label even when the content starts lowercase ("1. clean" → "clean")', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 EXECUTION' }),
        makePara({ text: '1. clean the surface' }), // pr2 ord 0 → label "1.", lowercase content
        makePara({ text: '2. apply primer' }), // pr2 ord 1 → label "2."
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const article = tree.parts[0]?.children[0];
    expect(article?.children.map((c) => c.text)).toEqual(['clean the surface', 'apply primer']);
  });

  // The article uppercase guard is UNCHANGED: a lowercase decimal-prose line at its
  // coincidental label position is still preserved (no data loss on measurements).
  it('still preserves a lowercase decimal-prose article at its label position (guard intact)', () => {
    const classified = classifyParagraphs(
      [makePara({ text: 'PART 1 - GENERAL' }), makePara({ text: '1.1 inches of clearance min' })],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    expect(tree.parts[0]?.children[0]?.text).toBe('1.1 inches of clearance min');
  });

  // Safety: a pr-label that is NOT the node's computed label at its position is kept
  // verbatim (never guess a strip).
  it('does NOT strip a pr-label that is not the computed label at its position', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 SUMMARY' }),
        makePara({ text: 'C. Misnumbered item at first position' }), // pr1 ord 0 → "A." ≠ "C." → keep
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const pr = tree.parts[0]?.children[0]?.children[0];
    expect(pr?.text).toBe('C. Misnumbered item at first position');
  });

  // Safety: a Word/style-NUMBERED pr item (Signal 1/2) gets its "A." from the numbering
  // definition, so its VISIBLE text is content — never stripped, even when it opens with a
  // letter that matches its label. Only manual (Signal-4) outlines are touched.
  it('does NOT strip a NUMBERED pr item whose text opens with its label letter (content)', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 SUMMARY' }),
        makePara({ text: 'A. Datum reference frame', numId: 5, ilvl: 2 }), // Signal 1 → pr1, content
      ],
      numMap(),
      emptyStyleMap()
    );
    expect(classified[2]?.signalUsed).toBe(1);
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const pr = tree.parts[0]?.children[0]?.children[0];
    expect(pr?.text).toBe('A. Datum reference frame');
  });

  // Codex adversarial review (P2 data-loss): the label-match strip must run ONLY on
  // Signal-4 (manual text-outline) articles. A Word/style-NUMBERED article (Signal 1/2)
  // gets its number from the numbering definition, so its VISIBLE text is pure content —
  // it must never be strip-touched even if it happens to open with its label number.
  // "1.1 mm tolerance" as the first numbered article would otherwise lose "1.1".
  it('does NOT strip a Signal-1/2 numbered article whose content starts with its label', () => {
    const tree = buildTree(
      [
        makeClassified('part', 0, 'PART 1 - GENERAL'),
        makeClassified('article', 1, '1.1 mm tolerance'), // makeClassified → signalUsed 1
      ],
      '01',
      'T',
      'unknown'
    );
    expect(tree.parts[0]?.children[0]?.text).toBe('1.1 mm tolerance'); // content preserved
  });

  // Codex adversarial review (P2 data-loss), end-to-end: a Signal-4 (manual text-outline)
  // paragraph that is decimal PROSE whose number coincides with its computed label — the
  // exact case Codex flagged: "1.1 inches of clearance minimum" as the first article under
  // PART 1 (label 1.1). The lowercase "inches" marks it as a value, not a heading, so the
  // number is preserved. Before the uppercase-first guard this dropped "1.1".
  it('preserves Signal-4 decimal prose whose number equals its label (lowercase → value)', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 inches of clearance minimum' }),
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    expect(tree.parts[0]?.children[0]?.text).toBe('1.1 inches of clearance minimum');
  });

  // KNOWN AMBIGUITY: a measurement with a CAPITAL-leading unit ("1.2 GHz frequency band")
  // that is itself a Signal-4 top-level article sitting at EXACTLY its own computed label
  // is textually identical to a heading — "GHz" looks like the first word of a Title.
  // Neither position nor text can separate them, so the label-match strip treats it as a
  // heading and removes "1.2". This is the residual, irreducible intersection of (capital
  // unit) × (Signal-4 article) × (exact-ordinal match); it does NOT occur in the reference
  // corpus, and real measurements live in pr-level content or continuations — which the
  // article-only strip never touches. We document the behavior here rather than silently
  // picking it; preferring "keep" here would double the label on every genuine heading at
  // its position (the original bug this whole pass fixes).
  it('KNOWN AMBIGUITY: capital-unit measurement at its exact label ordinal is stripped', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: '1.1 MANUFACTURERS' }), // ord 0 → label 1.1 (real heading)
        makePara({ text: '1.2 GHz frequency band' }), // ord 1 → label 1.2 == number, capital G → stripped
      ],
      numMap(),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const kids = tree.parts[0]?.children ?? [];
    expect(kids[0]?.text).toBe('MANUFACTURERS');
    // The 2nd article's label is "1.2"; the measurement literally opens "1.2 G…" → stripped.
    expect(kids[1]?.text).toBe('GHz frequency band');
  });

  // #296: hidden content is classified as a continuation (suppressed), not a part,
  // and keeps its full text verbatim — retained as-authored for document-control
  // tracking. The part prefix-strip (makeNode/nodeContent) only runs for real part
  // nodes, so a hidden "PART 3 - EXECUTION" is never touched.
  it('does NOT strip the prefix from hidden content (kept verbatim, suppressed)', () => {
    const tree = buildTree(
      [makeClassified('continuation', 0, 'PART 3 - EXECUTION', true)],
      '01',
      'T',
      'cpi'
    );
    expect(tree.parts[0]?.type).toBe('continuation');
    expect(tree.parts[0]?.meta.vanish).toBe(true);
    expect(tree.parts[0]?.text).toBe('PART 3 - EXECUTION');
  });

  // Codex review: stripping "PART 3 - " (9 chars) must rebase the part's source-fact
  // offsets onto the shorter text, or comment/color anchors point past it.
  it('rebases a part node’s source-fact offsets when the prefix is stripped', () => {
    const cp: ClassifiedParagraph = {
      paragraph: {
        text: 'PART 3 - EXECUTION',
        isVanish: false,
        sourceFacts: {
          comments: [{ author: 'A', text: 'check', anchor: [9, 18], closed: false }],
          colors: [{ color: 'FF0000', coverage: 0.5, spans: [[9, 18]] }],
        },
      },
      resolvedIlvl: 0,
      nodeType: 'part',
      signalUsed: 1,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree([cp], '01', 'T', 'cpi');
    const part = tree.parts[0]!;
    const facts = part.meta.sourceFacts!;
    expect(part.text).toBe('EXECUTION');
    expect(facts.comments![0]!.anchor).toEqual([0, 9]);
    expect(facts.colors![0]!.spans).toEqual([[0, 9]]);
    expect(facts.colors![0]!.coverage).toBe(1);
  });

  it('handles sibling articles (ilvl stepping back to article level)', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
      makeClassified('article', 1, '1.2'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(2);
    expect(tree.parts[0]?.children[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[1]?.children).toHaveLength(0);
  });

  // Regression (#122): a blank paragraph that inherits a numbered style (Signal 2)
  // was emitted as an empty numbered node, rendering a phantom "13." row and
  // consuming a CSI number. Empty paragraphs are layout spacing and must be dropped.
  it('drops an empty numbered paragraph instead of emitting a blank node', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr2', 3, 'first'),
      makeClassified('pr2', 3, ''),
      makeClassified('pr2', 3, 'second'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const prs = tree.parts[0]?.children[0]?.children ?? [];
    expect(prs.map((n) => n.text)).toEqual(['first', 'second']);
  });

  it('keeps a non-empty punctuation-only paragraph (e.g. a stray tailoring bracket)', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr2', 3, 'first'),
      makeClassified('pr2', 3, ']'),
      makeClassified('pr2', 3, 'second'),
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const prs = tree.parts[0]?.children[0]?.children ?? [];
    expect(prs.map((n) => n.text)).toEqual(['first', ']', 'second']);
  });
});

describe('buildTree — Pass 2: edge cases and meta', () => {
  it('assigns UUID to tree and all nodes', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01', 'T', 'arcat');
    expect(tree.id).toMatch(/^[\da-f-]{36}$/);
    expect(tree.parts[0]?.id).toMatch(/^[\da-f-]{36}$/);
  });

  it('handles ilvl jump forward > 1 without synthetic nodes', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('pr1', 2, 'A. text'), // jumps from 0 to 2, skipping article
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.type).toBe('pr1');
  });

  it('attaches continuation to last non-continuation paragraph', () => {
    const cont: ClassifiedParagraph = {
      paragraph: { text: 'cont text', isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('pr1', 2, 'A. text'),
      cont,
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const pr1 = tree.parts[0]?.children[0]?.children[0];
    expect(pr1?.children).toHaveLength(1);
    expect(pr1?.children[0]?.type).toBe('continuation');
  });

  it('sets meta.source from source parameter', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01', 'T', 'cpi');
    expect(tree.parts[0]?.meta.source).toBe('cpi');
  });

  // #296: a hidden (vanish) paragraph is a SUPPRESSED continuation, not a note —
  // only a genuine specifier note (banner/style, see inference-notes.test.ts)
  // becomes a [NOTE]. classifyParagraphs routes hidden content to a continuation;
  // buildTree carries meta.vanish so every renderer drops it.
  it('classifies a hidden non-note paragraph as a suppressed continuation', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ isVanish: true, text: 'PROCESSING FORM — internal use only' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const hidden = tree.parts[0]?.children[0];
    expect(hidden?.type).toBe('continuation');
    expect(hidden?.meta.vanish).toBe(true);
  });
});

describe('buildTree — conflicts propagation (#56)', () => {
  it('propagates ClassifiedParagraph.conflicts to SpecNode.meta.conflicts', () => {
    const conflicted: ClassifiedParagraph = {
      ...makeClassified('pr1', 2, 'A. text'),
      conflicts: [
        { signal: 2, reportedIlvl: 1, reportedNodeType: 'article' },
        { signal: 5, reportedIlvl: 3, reportedNodeType: 'pr2' },
      ],
    };
    const tree = buildTree(
      [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1'), conflicted],
      '01',
      'T',
      'arcat'
    );
    const node = tree.parts[0]?.children[0]?.children[0];
    expect(node?.meta.conflicts).toHaveLength(2);
    expect(node?.meta.conflicts?.[0]).toEqual({
      signal: 2,
      reportedIlvl: 1,
      reportedNodeType: 'article',
    });
    expect(node?.meta.conflicts?.[1]?.reportedNodeType).toBe('pr2');
  });

  it('omits meta.conflicts entirely when the paragraph has no conflicts', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01', 'T', 'arcat');
    expect(tree.parts[0]?.meta.conflicts).toBeUndefined();
    expect(Object.keys(tree.parts[0]?.meta ?? {})).not.toContain('conflicts');
  });

  it('continuation nodes never carry conflicts', () => {
    const cont: ClassifiedParagraph = {
      paragraph: { text: 'cont text', isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree([makeClassified('part', 0, 'PART 1'), cont], '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.meta.conflicts).toBeUndefined();
  });
});

describe('classifyParagraphs — numbering-generated PART headings (spec-shaped regression)', () => {
  const specShaped = (): NumberingMap => ({
    ...emptyNumberingMap(),
    articleIlvl: 1,
    specShapedNumIds: new Set([1]),
  });

  it('regression: ilvl=0 "GENERAL" with spec-shaped numbering → part (yielded 34 roots, not 3)', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, text: 'GENERAL' })],
      specShaped(),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('part');
    expect(result[0]?.signalUsed).toBe(1);
  });

  it('ilvl=0 generic text on a NON-spec-shaped numId is still rejected — LibreOffice guard intact', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 7, ilvl: 0, text: 'All work shall comply with applicable standards.' })],
      specShaped(),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).not.toBe('part');
  });

  it('literal "PART 1 – GENERAL" still classifies as part without spec-shaped evidence', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 9, ilvl: 0, text: 'PART 1 – GENERAL' })],
      specShaped(),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('part');
  });
});

describe('agreed signals (hierarchy-confidence provenance)', () => {
  it('signal that matches the winner nodeType+ilvl lands in agreed, not conflicts', () => {
    // S1: numId=1 ilvl=2, articleIlvl=1 → pr1 (normalized 2). S4: "A. " → pr1 (2).
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 2, text: 'A. Provide products as specified' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.agreed).toEqual([4]);
    expect(result[0]?.conflicts).toEqual([]);
  });

  it('disagreeing signal lands in conflicts, never in agreed', () => {
    // S1: ilvl=1 → article (1). S4: "A. " → pr1 (2) — disagrees.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 1, text: 'A. Provide products as specified' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('article');
    expect(result[0]?.agreed).toEqual([]);
    expect(result[0]?.conflicts.map((c) => c.signal)).toEqual([4]);
  });

  it('indentation corroboration: matching indent tier lands in agreed', () => {
    // S1: ilvl=2 → pr1 (2). S5: 1152 twips / 576 = tier 2 → pr1. No S4 pattern.
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 2, leftIndent: 1152, text: 'Some content here' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(1);
    expect(result[0]?.agreed).toEqual([5]);
  });

  it('agreed is computed against the POST-correctMisalignedArticle resolution', () => {
    // S1 says article (ilvl=1) but indentation sits at tier 3 (1728 twips) with no
    // second article vote → demoted to the first non-article hit: S4 "1. " → pr2 (3).
    // S5 (tier 3 → pr2) matches the FINAL type → agreed; the losing S1 article → conflicts.
    const result = classifyParagraphs(
      [
        makePara({
          numId: 13,
          ilvl: 1,
          leftIndent: 1728,
          text: '1. Normal street clothes and shoes',
        }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('pr2');
    expect(result[0]?.signalUsed).toBe(4);
    expect(result[0]?.agreed).toEqual([5]);
    expect(result[0]?.conflicts.map((c) => c.signal)).toContain(1);
  });

  it('continuation (no signal fired) carries an empty agreed set', () => {
    const result = classifyParagraphs(
      [makePara({ text: 'unclassifiable' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.nodeType).toBe('continuation');
    expect(result[0]?.agreed).toEqual([]);
  });

  it('lone indentation win: empty agreed, empty conflicts', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 1152, text: 'Loose trailing fragment' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.signalUsed).toBe(5);
    expect(result[0]?.agreed).toEqual([]);
    expect(result[0]?.conflicts).toEqual([]);
  });
});

describe('meta.inference (parse-time scoring)', () => {
  it('structural nodes carry meta.inference with confidence in [0,1]', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ numId: 1, ilvl: 1, text: '1.1 SUMMARY' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const part = tree.parts[0];
    expect(part?.meta.inference).toBeDefined();
    expect(part?.meta.inference?.confidence).toBeGreaterThanOrEqual(0);
    expect(part?.meta.inference?.confidence).toBeLessThanOrEqual(1);
    const article = part?.children[0];
    expect(article?.meta.inference?.signalUsed).toBe(1);
  });

  it('non-structural nodes (notes, continuations) never carry meta.inference', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ text: 'plain continuation body text' }),
        makePara({ text: '** NOTE TO SPECIFIER ** pick one', isVanish: true }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const children = tree.parts[0]?.children ?? [];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.meta.inference).toBeUndefined();
    }
  });

  it('lone-indentation node scores below the 0.6 review threshold', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: 'PART 1 - GENERAL' }),
        makePara({ leftIndent: 1152, text: 'Loose indented fragment' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'unknown');
    const indented = tree.parts[0]?.children[0];
    expect(indented?.meta.inference?.signalUsed).toBe(5);
    expect(indented?.meta.inference?.confidence).toBeLessThan(0.6);
    expect(indented?.meta.inference?.evidence).toContain('indentation won alone');
  });
});

describe('auditTreeStructure — non-conforming part numbering (#316)', () => {
  const rootPart = (text: string): SpecNode => ({
    id: text,
    type: 'part',
    text,
    children: [],
    meta: {},
  });

  it('warns: PART 1.1 decimal part heading is non-conforming — with lineHint', () => {
    const warnings = auditTreeStructure([rootPart('PART 1.1 GENERAL'), rootPart('PRODUCTS')]);
    const nonConforming = warnings.filter((w) => w.type === 'non-conforming-part-numbering');
    expect(nonConforming).toHaveLength(1);
    expect(nonConforming[0]?.lineHint).toBe('PART 1.1 GENERAL');
  });

  it('conforming parts (stripped names) yield no non-conforming-part-numbering warning', () => {
    const warnings = auditTreeStructure([
      rootPart('GENERAL'),
      rootPart('PRODUCTS'),
      rootPart('EXECUTION'),
    ]);
    expect(warnings.some((w) => w.type === 'non-conforming-part-numbering')).toBe(false);
  });

  it('>5 parts stays owned by unusual-part-count, not the new warning (distinct signals)', () => {
    const warnings = auditTreeStructure(
      Array.from({ length: 6 }, (_, i) => rootPart(`NAME ${i + 1}`))
    );
    expect(warnings.some((w) => w.type === 'unusual-part-count')).toBe(true);
    expect(warnings.some((w) => w.type === 'non-conforming-part-numbering')).toBe(false);
  });
});

// ─── buildTree — body object attachment (#300, ADR-072) ─────────────────────
// A captured table/text-box SpecNode (index.ts, a sibling task, converts a
// CapturedBodyObject into one of these) is attached at tree-build time via
// two new optional buildTree params: `objectsBeforeFirst` (a table before the
// document's first paragraph) and `objectsByPrecedingIndex` (everything
// else, keyed on the ORIGINAL classified-paragraph array index it follows).
// The two invariants pinned below are the ones the spike found buildTree's
// prior "trailing child after stack-push" mechanism could NOT satisfy:
//   - Document-order conservation: an object attaches after the exact
//     paragraph it followed in the source XML, even when that paragraph is
//     an EMPTY spacer buildTree's own content pre-filter would otherwise
//     have dropped before ever reaching the stack-push loop (2 of 3 real
//     table hosts in the proof fixture are exactly this).
//   - No-silent-loss: every object passed in, at every attachment point
//     (before the first paragraph, mid-tree, or trailing the very last
//     paragraph before the final stack drain), survives into the tree.
function makeObjectNode(id: string, text = 'Table'): SpecNode {
  return { id, type: 'object', text, children: [], meta: {} };
}

describe('buildTree — body object attachment: document-order conservation (#300)', () => {
  it('inference: document-order conservation — object anchored on a filtered EMPTY spacer paragraph still attaches after the preceding structural node', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('continuation', 0, ''), // empty spacer paragraph at index 1 — dropped by the content pre-filter
    ];
    const obj = makeObjectNode('obj-1');
    const tree = buildTree(classified, '01', 'T', 'unknown', [], new Map([[1, [obj]]]));

    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.children).toEqual([obj]);
  });

  it('inference: document-order conservation — objectsBeforeFirst precedes every root, including the first PART', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const obj = makeObjectNode('obj-0');
    const tree = buildTree(classified, '01', 'T', 'unknown', [obj], new Map());

    expect(tree.parts[0]).toEqual(obj);
    expect(tree.parts[1]?.type).toBe('part');
  });

  it('inference: document-order conservation — an object anchored to a structural paragraph nests as ITS child, and the paragraph after it starts a new sibling', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, '1.1'),
      makeClassified('article', 1, '1.2'),
    ];
    const obj = makeObjectNode('obj-mid');
    // Anchored at index 1 (article "1.1") — a table that follows "1.1" in the
    // XML but precedes "1.2" nests under 1.1, exactly like a continuation
    // paragraph in the same position would.
    const tree = buildTree(classified, '01', 'T', 'unknown', [], new Map([[1, [obj]]]));

    const part = tree.parts[0];
    expect(part?.children).toHaveLength(2);
    expect(part?.children[0]?.children).toEqual([obj]);
    expect(part?.children[1]?.type).toBe('article');
  });
});

describe('buildTree — body object attachment: no-silent-loss (#300)', () => {
  it('inference: no-silent-loss — multiple objects anchored at the same index are ALL attached, in order, none dropped', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const objA = makeObjectNode('obj-a');
    const objB = makeObjectNode('obj-b');
    const tree = buildTree(classified, '01', 'T', 'unknown', [], new Map([[0, [objA, objB]]]));

    expect(tree.parts[0]?.children).toEqual([objA, objB]);
  });

  it('inference: no-silent-loss — an object anchored to the LAST classified paragraph survives the final stack drain', () => {
    const classified = [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1')];
    const obj = makeObjectNode('obj-last');
    const tree = buildTree(classified, '01', 'T', 'unknown', [], new Map([[1, [obj]]]));

    expect(tree.parts[0]?.children[0]?.children).toEqual([obj]);
  });

  it('inference: no-silent-loss — an objectsBeforeFirst object and an objectsByPrecedingIndex object both survive in the same tree', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const before = makeObjectNode('obj-before');
    const after = makeObjectNode('obj-after');
    const tree = buildTree(classified, '01', 'T', 'unknown', [before], new Map([[0, [after]]]));

    expect(tree.parts).toHaveLength(2);
    expect(tree.parts[0]).toEqual(before);
    expect(tree.parts[1]?.children).toEqual([after]);
  });

  it('inference: no-silent-loss — calling buildTree with no object args at all behaves exactly as before (backward-compatible default)', () => {
    const classified = [makeClassified('part', 0, 'PART 1')];
    const tree = buildTree(classified, '01', 'T', 'unknown');

    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.type).toBe('part');
  });
});

describe('auditTreeStructure — object roots are not junk (#300)', () => {
  it('an object root is excluded from root-continuation and does not count toward the part total', () => {
    const objectRoot = makeObjectNode('o1');
    const partRoot: SpecNode = { id: 'p1', type: 'part', text: 'GENERAL', children: [], meta: {} };
    const warnings = auditTreeStructure([objectRoot, partRoot]);

    expect(warnings.some((w) => w.type === 'root-continuation')).toBe(false);
  });
});

describe('buildTree — meta.pageBreakBefore propagation (ADR-075)', () => {
  it('propagates pageBreakBefore onto a structural node (part/article)', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 – GENERAL' }),
        makePara({ numId: 1, ilvl: 1, text: '1.1 SUMMARY', pageBreakBefore: true }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.meta.pageBreakBefore).toBeUndefined();
    expect(tree.parts[0]?.children[0]?.meta.pageBreakBefore).toBe(true);
  });

  it('omits meta.pageBreakBefore entirely when the paragraph carries no page break', () => {
    const tree = buildTree([makeClassified('part', 0, 'PART 1')], '01', 'T', 'arcat');
    expect(tree.parts[0]?.meta.pageBreakBefore).toBeUndefined();
    expect(Object.keys(tree.parts[0]?.meta ?? {})).not.toContain('pageBreakBefore');
  });

  it('propagates pageBreakBefore onto a plain continuation node (suppression-safe)', () => {
    const cont: ClassifiedParagraph = {
      paragraph: { text: 'cont text', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree(
      [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1'), cont],
      '01',
      'T',
      'arcat'
    );
    const node = tree.parts[0]?.children[0]?.children[0];
    expect(node?.type).toBe('continuation');
    expect(node?.meta.pageBreakBefore).toBe(true);
  });

  it('propagates pageBreakBefore onto a hidden (vanish) continuation node — a break preceding suppressed content is not dropped', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ isVanish: true, pageBreakBefore: true, text: 'PROCESSING FORM — internal use' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const hidden = tree.parts[0]?.children[0];
    expect(hidden?.type).toBe('continuation');
    expect(hidden?.meta.vanish).toBe(true);
    expect(hidden?.meta.pageBreakBefore).toBe(true);
  });

  it('propagates pageBreakBefore onto a note node', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({
          isVanish: true,
          pageBreakBefore: true,
          styleId: 'NoteStyle',
          text: '*Note: editorial guidance.',
        }),
      ],
      numMap(1),
      {
        styles: new Map([['NoteStyle', { styleId: 'NoteStyle', name: 'Note Style' }]]),
        resolvedNumPr: new Map(),
        resolvedJc: new Map(),
        vanishStyleIds: new Set(['NoteStyle']),
        vanishCharStyleIds: new Set(),
      }
    );
    const tree = buildTree(classified, '01', 'T', 'arcat');
    const note = tree.parts[0]?.children[0];
    expect(note?.type).toBe('note');
    expect(note?.meta.pageBreakBefore).toBe(true);
  });

  // #497 review finding: a page break preceding a paragraph that isStructuralContent
  // filters out entirely (an empty/blank spacer, or a suppressed rule-row delimiter,
  // #292) was silently discarded — buildTree never calls makeNode/makeContinuationNode
  // for a filtered paragraph, so pageBreakMeta never ran for it. The break must instead
  // surface on the next paragraph that actually becomes a SpecNode.
  it('#497: propagates pageBreakBefore across a filtered blank/empty spacer paragraph onto the next emitted node', () => {
    const blankSpacer: ClassifiedParagraph = {
      paragraph: { text: '   ', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const afterSpacer: ClassifiedParagraph = {
      paragraph: { text: 'Paragraph two text.', isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree(
      [
        makeClassified('part', 0, 'PART 1'),
        makeClassified('article', 1, '1.1'),
        blankSpacer,
        afterSpacer,
      ],
      '01',
      'T',
      'arcat'
    );
    const article = tree.parts[0]?.children[0];
    // The blank spacer produced no node of its own — only the real paragraph did.
    expect(article?.children).toHaveLength(1);
    expect(article?.children[0]?.text).toBe('Paragraph two text.');
    expect(article?.children[0]?.meta.pageBreakBefore).toBe(true);
  });

  it('#497: propagates pageBreakBefore across a suppressed rule-row delimiter (#292) onto the next emitted node', () => {
    const ruleRow: ClassifiedParagraph = {
      paragraph: { text: '*****', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
      suppressed: true,
    };
    const afterRuleRow: ClassifiedParagraph = {
      paragraph: { text: 'Note text after rule row.', isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree(
      [
        makeClassified('part', 0, 'PART 1'),
        makeClassified('article', 1, '1.1'),
        ruleRow,
        afterRuleRow,
      ],
      '01',
      'T',
      'arcat'
    );
    const article = tree.parts[0]?.children[0];
    // The suppressed rule row produced no node of its own.
    expect(article?.children).toHaveLength(1);
    expect(article?.children[0]?.text).toBe('Note text after rule row.');
    expect(article?.children[0]?.meta.pageBreakBefore).toBe(true);
  });

  it('KNOWN AMBIGUITY: a pageBreakBefore forwarded through a filtered paragraph with nothing structural after it (EOF) is silently dropped, never throws', () => {
    const trailingBlank: ClassifiedParagraph = {
      paragraph: { text: '', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const tree = buildTree(
      [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1'), trailingBlank],
      '01',
      'T',
      'arcat'
    );
    const article = tree.parts[0]?.children[0];
    expect(article?.children).toHaveLength(0);
  });

  // #497 review finding: document.ts's page-break lookback walks the raw <w:p>-only
  // array, oblivious to an interleaved w:tbl — so when a body object (table/text-box,
  // ADR-072) is captured immediately after the page-break-bearing paragraph, document.ts
  // still marks the NEXT PARAGRAPH (skipping the object entirely) as pageBreakBefore.
  // KNOWN AMBIGUITY (docs/adr/075-manual-page-break-round-trip.md): an object node has
  // no pageBreakBefore attachment point (decision 4 — ImportedObjectBlock re-emits raw
  // w:tbl XML, not a Paragraph), so the misattributed flag is dropped rather than
  // misapplied to the wrong paragraph.
  it('#497 KNOWN AMBIGUITY: a page break misattributed across an interposed body object is dropped, not misattached to the paragraph after the object', () => {
    const afterTable: ClassifiedParagraph = {
      paragraph: { text: 'Paragraph after table.', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const obj = makeObjectNode('table-obj');
    const tree = buildTree(
      [makeClassified('part', 0, 'PART 1'), makeClassified('article', 1, '1.1'), afterTable],
      '01',
      'T',
      'arcat',
      [],
      new Map([[1, [obj]]])
    );
    const article = tree.parts[0]?.children[0];
    expect(article?.children[0]).toEqual(obj);
    expect(article?.children[0]?.meta.pageBreakBefore).toBeUndefined();
    expect(article?.children[1]?.text).toBe('Paragraph after table.');
    expect(article?.children[1]?.meta.pageBreakBefore).toBeUndefined();
  });

  // #497 review finding: resolvePageBreakBefore only ran the object-adjacency
  // exclusion against a paragraph's OWN pageBreakBefore flag — `pendingPageBreak`
  // (a break forwarded through an earlier FILTERED paragraph, e.g. a spacer) was
  // OR'd in unconditionally, bypassing isPageBreakOwnedByPrecedingObject entirely.
  // A body object is a documented, real attachment target for a filtered spacer's
  // index (buildTree's own comment: "2 of 3 real table hosts in the proof fixture
  // are empty spacer paragraphs"), so the forwarded break must be dropped the same
  // way the direct-adjacency case is — never misattached to the paragraph AFTER
  // the object.
  it('#497 KNOWN AMBIGUITY: a page break forwarded through a filtered spacer is dropped when a body object is attached to that spacer, not misattached to the paragraph after the object', () => {
    const blankSpacer: ClassifiedParagraph = {
      paragraph: { text: '   ', isVanish: false, pageBreakBefore: true },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const afterTable: ClassifiedParagraph = {
      paragraph: { text: 'Paragraph after table.', isVanish: false },
      resolvedIlvl: 2,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
    };
    const obj = makeObjectNode('table-obj');
    const tree = buildTree(
      [
        makeClassified('part', 0, 'PART 1'),
        makeClassified('article', 1, '1.1'),
        blankSpacer,
        afterTable,
      ],
      '01',
      'T',
      'arcat',
      [],
      new Map([[2, [obj]]])
    );
    const article = tree.parts[0]?.children[0];
    // The blank spacer produced no node of its own — only the object and the real
    // paragraph did.
    expect(article?.children).toHaveLength(2);
    expect(article?.children[0]).toEqual(obj);
    expect(article?.children[0]?.meta.pageBreakBefore).toBeUndefined();
    expect(article?.children[1]?.text).toBe('Paragraph after table.');
    expect(article?.children[1]?.meta.pageBreakBefore).toBeUndefined();
  });
});
