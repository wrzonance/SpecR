import { describe, it, expect } from 'vitest';
import { classifyParagraphs, buildTree } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { ClassifiedParagraph, DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { NodeType } from '../../ast/types.js';

function emptyStyleMap(): StyleMap {
  return {
    styles: new Map(),
    resolvedNumPr: new Map(),
    vanishStyleIds: new Set(),
    vanishCharStyleIds: new Set(),
  };
}

function makePara(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text: '', isVanish: false, ...overrides };
}

const numMap = (articleIlvl = 1): NumberingMap => ({ ...emptyNumberingMap(), articleIlvl });

describe('classifyParagraphs — signal 1 (numId+ilvl)', () => {
  it('ARCAT-style ilvl=0 → part, normalizedIlvl=0', () => {
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

  it('CPI ilvl=3 → article when articleIlvl=3, normalizedIlvl=1', () => {
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

  it('ARCAT-style ilvl=7 and ilvl=8 map to pr6/pr7 before Word depth cap', () => {
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

  it('signal 1 wins over signal 2; conflict logged', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading2', { styleId: 'Heading2', name: 'heading 2' }]]),
      resolvedNumPr: new Map([['Heading2', { numId: 1, ilvl: 1 }]]),
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

  it('signal 5: classifies via indentation when signals 1+2+4 absent', () => {
    const result = classifyParagraphs(
      [makePara({ leftIndent: 576, text: 'Lorem ipsum dolor sit amet.' })],
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

describe('classifyParagraphs — CPI regressions', () => {
  it('PR1lc suppressesNumbering → continuation not pr1', () => {
    const styleMap: StyleMap = {
      styles: new Map([
        ['PR1', { styleId: 'PR1', name: 'PR1' }],
        ['PR1lc', { styleId: 'PR1lc', name: 'PR1lc', suppressesNumbering: true, basedOn: 'PR1' }],
      ]),
      resolvedNumPr: new Map([['PR1', { numId: 2, ilvl: 4 }]]),
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
    expect(result[0]?.signalUsed).toBe(5); // indentation wins
    // the discarded Signal-1 article is persisted as a conflict, never dropped
    expect(
      result[0]?.conflicts.some((c) => c.signal === 1 && c.reportedNodeType === 'article')
    ).toBe(true);
  });

  it('keeps a Signal-1 article when indentation agrees within 1 tier (real CPI article ≈900 twips)', () => {
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

  // Regression (parsing-needs-fixing.docx): a CPI PART heading whose literal run
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

  // A hidden (vanish) PART becomes a note and keeps its full text verbatim —
  // hidden content is retained as-authored for document-control tracking, so the
  // prefix-strip must not touch it.
  it('does NOT strip the prefix from a hidden part (kept verbatim as a note)', () => {
    const tree = buildTree(
      [makeClassified('part', 0, 'PART 3 - EXECUTION', true)],
      '01',
      'T',
      'cpi'
    );
    expect(tree.parts[0]?.type).toBe('note');
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

  it('overrides nodeType to note for vanish paragraphs', () => {
    const classified = [
      makeClassified('part', 0, 'PART 1'),
      makeClassified('article', 1, 'note text', true), // isVanish=true
    ];
    const tree = buildTree(classified, '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.type).toBe('note');
    expect(tree.parts[0]?.children[0]?.meta.vanish).toBe(true);
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
      isVanish: false,
    };
    const tree = buildTree([makeClassified('part', 0, 'PART 1'), cont], '01', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.meta.conflicts).toBeUndefined();
  });
});

describe('classifyParagraphs — numbering-generated PART headings (ARCAT regression)', () => {
  const specShaped = (): NumberingMap => ({
    ...emptyNumberingMap(),
    articleIlvl: 1,
    specShapedNumIds: new Set([1]),
  });

  it('regression: ilvl=0 "GENERAL" with spec-shaped numbering → part (21 11 00 yielded 34 roots, not 3)', () => {
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
