import { describe, it, expect } from 'vitest';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';
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
      resolvedJc: new Map(),
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

  // The ARCAT preamble line "Display hidden notes to specifier. (Click Here)" is
  // VISIBLE (not w:vanish), carries no note banner, and its style is not note-named,
  // so before the isSpecifierNoteInstruction signal it leaked into CSI body as a
  // visible continuation. It must classify as a note (editorial), never as content.
  it('visible "Display hidden notes to specifier" instruction → note node, not CSI content', () => {
    const classified = classifyParagraphs(
      [
        makePara({
          text: "Display hidden notes to specifier. (Don't know how? Click Here)",
        }),
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    // classified as a note (isNote), routed to the note branch, never a visible node
    expect(classified[0]?.isNote).toBe(true);
    const tree = buildTree(classified, '26 09 33', 'T', 'arcat');
    const root = tree.parts[0];
    expect(root?.type).toBe('note');
    expect(root?.type).not.toBe('continuation');
  });

  it('FootnoteText style is NOT a specifier note', () => {
    const styleMap: StyleMap = {
      styles: new Map([['FootnoteText', { styleId: 'FootnoteText', name: 'footnote text' }]]),
      resolvedNumPr: new Map(),
      resolvedJc: new Map(),
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

describe('classifyParagraphs + buildTree — asterisk-rule note regions (#292)', () => {
  it('a paired rule-row pair suppresses the rows and classifies enclosed prose as note', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '*****' }),
        makePara({ text: 'Delete items below not applicable to this project.' }),
        makePara({ text: '*****' }),
        makePara({ text: 'Ordinary body text after the region closes.' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    // Both rule rows produce no SpecNode at all.
    expect(classified[1]!.suppressed).toBe(true);
    expect(classified[3]!.suppressed).toBe(true);
    expect(classified[2]!.isNote).toBe(true);

    const tree = buildTree(classified, '01 00 00', 'T', 'arcat');
    const children = tree.parts[0]!.children;
    expect(children).toHaveLength(2);
    // No rule-row text survives into the tree, in any node.
    expect(children.some((n) => n.text === '*****')).toBe(false);
    expect(children[0]!.type).toBe('note');
    expect(children[0]!.text).toBe('Delete items below not applicable to this project.');
    expect(children[1]!.type).toBe('continuation');
    expect(children[1]!.text).toBe('Ordinary body text after the region closes.');
  });

  // Codex (PR #461): a paragraph structural ONLY via Signal 2 (its STYLE resolves to a
  // real tier through resolvedNumPr) — no direct numId and no literal "PART n"/"N.N"
  // text — is invisible to BOTH the Signal-1 numbering drift check and the text-pattern
  // heading gate. Inside a drifted (unpaired) asterisk wall it was swallowed as a
  // [NOTE], the exact structure-loss class the drift guard exists to prevent. The drift
  // signal now also consults Signal 2 (trySignal2), so such a heading trips the guard
  // and the convention disengages document-wide — the paragraph classifies normally.
  it('#292 (Codex #461): a style-numbered structural paragraph (no numId) inside a drifted wall trips the drift guard, not swallowed as a note', () => {
    const styleMap: StyleMap = {
      styles: new Map([['ARCATArticle', { styleId: 'ARCATArticle', name: 'ARCATArticle' }]]),
      resolvedNumPr: new Map([['ARCATArticle', { numId: 5, ilvl: 1 }]]),
      resolvedJc: new Map(),
      vanishStyleIds: new Set(),
      vanishCharStyleIds: new Set(),
    };
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '*****' }), // unpaired opener — the wall has drifted out of phase
        makePara({ styleId: 'ARCATArticle', text: 'Submittals shall include product data.' }),
      ],
      numMap(1),
      styleMap
    );
    // The style-numbered paragraph is NOT a swallowed note; it resolves via Signal 2.
    expect(classified[2]?.isNote).not.toBe(true);
    expect(classified[2]?.nodeType).toBe('article');
    expect(classified[2]?.signalUsed).toBe(2);
  });

  // KNOWN AMBIGUITY (mirrors note-roles.test.ts): an unpaired opener with no closing
  // rule row is force-closed only by a literal PART/article heading. When one appears,
  // everything from the opener through the paragraph before the heading becomes a
  // suppressed rule / note; the heading itself and everything after resume normal
  // inference untouched.
  it('an unpaired opener force-closed by a PART heading suppresses the opener and notes the interior; the heading resumes normal inference', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '*****' }),
        makePara({ text: 'Coordinate with the owner before proceeding.' }),
        makePara({ numId: 1, ilvl: 0, text: 'PART 2 - PRODUCTS' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(classified[1]?.suppressed).toBe(true);
    expect(classified[2]?.isNote).toBe(true);
    // The heading paragraph is untouched by the note-region scan — it still resolves
    // via the 5-signal engine, not forced to 'none'/continuation.
    expect(classified[3]?.nodeType).toBe('part');
    expect(classified[3]?.signalUsed).toBe(1);

    const tree = buildTree(classified, '01 00 00', 'T', 'arcat');
    expect(tree.parts).toHaveLength(2);
    expect(tree.parts[0]?.children).toHaveLength(1);
    expect(tree.parts[0]?.children[0]?.type).toBe('note');
    expect(tree.parts[1]?.type).toBe('part');
  });

  // classifyOne checks role === 'rule' FIRST, ahead of the isVanish guard (see the
  // comment at that call site) — a rule row that also happens to carry w:vanish must
  // still be suppressed, not fall through to the vanish/continuation branch instead.
  it('#292: a rule row is suppressed regardless of vanish state — the rule-row check runs ahead of the vanish guard', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ isVanish: true, text: '*****' }),
        makePara({ text: 'Delete items below not applicable to this project.' }),
        makePara({ text: '*****' }),
        makePara({ text: 'Ordinary body text after the region closes.' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(classified[1]!.suppressed).toBe(true);
    expect(classified[1]!.isVanish).toBe(true); // isVanish still recorded verbatim
    expect(classified[3]!.suppressed).toBe(true);

    const tree = buildTree(classified, '01 00 00', 'T', 'arcat');
    const children = tree.parts[0]!.children;
    // The vanish rule row produces no SpecNode, same as a non-vanish one.
    expect(children.some((n) => n.text === '*****')).toBe(false);
    expect(children).toHaveLength(2);
  });

  // Regression guard: dash/equals decoration rules (e.g. "----", "====") are handled
  // exclusively by the existing isDecorationSeparator path (heuristics.ts) and must
  // NOT be affected by the new rule-row-first check — isRuleRow is asterisk-only.
  it('dash and equals decoration rules are unaffected — still a plain continuation, never suppressed or note', () => {
    const classified = classifyParagraphs(
      [
        makePara({ numId: 1, ilvl: 0, text: 'PART 1 - GENERAL' }),
        makePara({ text: '----------' }),
        makePara({ text: '==========' }),
      ],
      numMap(1),
      emptyStyleMap()
    );
    expect(classified[1]?.suppressed).not.toBe(true);
    expect(classified[1]?.isNote).not.toBe(true);
    expect(classified[1]?.nodeType).toBe('continuation');
    expect(classified[2]?.suppressed).not.toBe(true);
    expect(classified[2]?.isNote).not.toBe(true);
    expect(classified[2]?.nodeType).toBe('continuation');
  });
});

describe('classifyParagraphs — note-style name matching (CodeRabbit #113)', () => {
  it('regression: AppendixNote style IS a note — "append" contains "end" and must not be excluded', () => {
    const styleMap: StyleMap = {
      styles: new Map([['AppendixNote', { styleId: 'AppendixNote', name: 'AppendixNote' }]]),
      resolvedNumPr: new Map(),
      resolvedJc: new Map(),
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
      resolvedJc: new Map(),
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
