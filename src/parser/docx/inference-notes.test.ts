import { describe, it, expect } from 'vitest';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { NodeType, SpecNode } from '../../ast/types.js';

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

describe('classifyParagraphs + buildTree — specifier notes become vanish notes', () => {
  it('banner text "** NOTE TO SPECIFIER **" → note node with meta.vanish', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '** NOTE TO SPECIFIER ** Delete items below not required.' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '21 11 00', 'T', 'arcat');
    const note = tree.parts[0]?.children[0];
    expect(note?.type).toBe('note');
    expect(note?.meta.vanish).toBe(true);
  });

  it('note-named style (ARCATnote) without banner text → note node with meta.vanish', () => {
    const styleMap: StyleMap = {
      styles: new Map([['ARCATnote', { styleId: 'ARCATnote', name: 'ARCATnote' }]]),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ styleId: 'ARCATnote', text: 'Coordinate paint colors with Architect.' }),
      ],
      numMap(1),
      styleMap
    );
    const tree = buildTree(classified, '21 11 00', 'T', 'arcat');
    const note = tree.parts[0]?.children[0];
    expect(note?.type).toBe('note');
    expect(note?.meta.vanish).toBe(true);
  });

  // #296: a fully-hidden paragraph that is NOT a specifier note (sign-off forms,
  // processing forms, document-control chrome) must become a SUPPRESSED non-note
  // node (continuation + meta.vanish), not a visible [NOTE]. Renderers display
  // note nodes regardless of meta.vanish, so misrepresenting hidden body content
  // as a note leaked it into every render.
  it('#296: hidden non-note paragraph → suppressed continuation with meta.vanish, not a note', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ isVanish: true, text: 'SIGN-OFF: ______  Reviewed by ______' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01 00 00', 'T', 'cpi');
    const hidden = tree.parts[0]?.children[0];
    expect(hidden?.type).toBe('continuation');
    expect(hidden?.type).not.toBe('note');
    expect(hidden?.meta.vanish).toBe(true);
    expect(hidden?.text).toBe('SIGN-OFF: ______  Reviewed by ______');
  });

  it('#296: hidden non-note paragraph at root → suppressed continuation, text kept verbatim', () => {
    const classified = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, isVanish: true, text: 'PART 3 - EXECUTION' })],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '01 00 00', 'T', 'cpi');
    const node = tree.parts[0];
    expect(node?.type).toBe('continuation');
    expect(node?.meta.vanish).toBe(true);
    // hidden content is retained as-authored — the "PART 3 - " prefix is NOT stripped
    expect(node?.text).toBe('PART 3 - EXECUTION');
  });

  it('FootnoteText style is NOT a specifier note', () => {
    const styleMap: StyleMap = {
      styles: new Map([['FootnoteText', { styleId: 'FootnoteText', name: 'footnote text' }]]),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const classified = classifyParagraphs(
      [makePara({ styleId: 'FootnoteText', text: 'See appendix for details.' })],
      numMap(1),
      styleMap
    );
    expect(classified[0]?.isVanish).toBe(false);
  });
});

describe('auditTreeStructure — sanity post-pass warnings', () => {
  function leaf(type: NodeType, text: string): SpecNode {
    return { id: 't', type, text, children: [], meta: {} };
  }

  it('zero parts → no-structure-found warning', () => {
    const warnings = auditTreeStructure([leaf('article', 'SECTION INCLUDES')]);
    expect(warnings.some((w) => w.type === 'no-structure-found')).toBe(true);
  });

  it('non-part root nodes → root-continuation warning with count', () => {
    const warnings = auditTreeStructure([
      leaf('continuation', 'Copyright 2018 ARCAT'),
      leaf('part', 'GENERAL'),
    ]);
    const w = warnings.find((x) => x.type === 'root-continuation');
    expect(w).toBeDefined();
    expect(w?.suggestion).toContain('1');
  });

  it('4-5 parts → unusual-part-count warning noting MasterFormat allows it', () => {
    const parts = Array.from({ length: 4 }, (_, i) => leaf('part', `P${i}`));
    const warnings = auditTreeStructure(parts);
    const w = warnings.find((x) => x.type === 'unusual-part-count');
    expect(w?.suggestion).toContain('MasterFormat allows');
  });

  it('more than 5 parts → unusual-part-count warning suggesting over-matching', () => {
    const parts = Array.from({ length: 7 }, (_, i) => leaf('part', `P${i}`));
    const warnings = auditTreeStructure(parts);
    const w = warnings.find((x) => x.type === 'unusual-part-count');
    expect(w?.suggestion).toContain('over-matched');
  });

  it('healthy 3-part tree with no junk roots → no warnings', () => {
    const parts = [leaf('part', 'GENERAL'), leaf('part', 'PRODUCTS'), leaf('part', 'EXECUTION')];
    expect(auditTreeStructure(parts)).toEqual([]);
  });
});

describe('buildTree — empty paragraphs are dropped', () => {
  it('regression: empty continuation paragraphs rendered as blank PART rows in the demo', () => {
    const classified = classifyParagraphs(
      [
        makePara({ text: '' }),
        makePara({ text: '   ' }),
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '' }),
        makePara({ text: 'Real continuation text.' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    const tree = buildTree(classified, '21 11 00', 'T', 'arcat');
    expect(tree.parts).toHaveLength(1);
    expect(tree.parts[0]?.type).toBe('part');
    const childTexts = tree.parts[0]?.children.map((c) => c.text);
    expect(childTexts).toEqual(['Real continuation text.']);
  });
});

describe('classifyParagraphs — note-style name matching (CodeRabbit #113)', () => {
  it('regression: AppendixNote style IS a note — "append" contains "end" and must not be excluded', () => {
    const styleMap: StyleMap = {
      styles: new Map([['AppendixNote', { styleId: 'AppendixNote', name: 'AppendixNote' }]]),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ styleId: 'AppendixNote', text: 'See the appendix for finishes.' }),
      ],
      numMap(1),
      styleMap
    );
    const tree = buildTree(classified, '01 00 00', 'T', 'arcat');
    expect(tree.parts[0]?.children[0]?.type).toBe('note');
  });

  it('EndnoteText style is NOT a specifier note', () => {
    const styleMap: StyleMap = {
      styles: new Map([['EndnoteText', { styleId: 'EndnoteText', name: 'endnote text' }]]),
      resolvedNumPr: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const classified = classifyParagraphs(
      [makePara({ styleId: 'EndnoteText', text: 'See bibliography.' })],
      numMap(1),
      styleMap
    );
    expect(classified[0]?.isVanish).toBe(false);
  });
});
