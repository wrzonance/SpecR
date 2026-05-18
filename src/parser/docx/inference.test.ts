import { describe, it, expect } from 'vitest';
import { classifyParagraphs, buildTree } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { ClassifiedParagraph, DocxParagraph, NumberingMap, StyleMap } from './types.js';
import type { NodeType } from '../../ast/types.js';

function emptyStyleMap(): StyleMap {
  return { styles: new Map(), resolvedNumPr: new Map() };
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
});

describe('classifyParagraphs — signal 2 (style resolvedNumPr)', () => {
  it('classifies via style resolvedNumPr', () => {
    const styleMap: StyleMap = {
      styles: new Map([['Heading1', { styleId: 'Heading1', name: 'heading 1' }]]),
      resolvedNumPr: new Map([['Heading1', { numId: 1, ilvl: 0 }]]),
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

  it('vanish paragraph: isVanish propagated from DocxParagraph', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0, isVanish: true, text: 'PART 1 – GENERAL' })],
      numMap(1),
      emptyStyleMap()
    );
    expect(result[0]?.isVanish).toBe(true);
    expect(result[0]?.nodeType).toBe('part');
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
    };
    const result = classifyParagraphs(
      [makePara({ styleId: 'PR1lc', text: 'This continues the paragraph above.' })],
      numMap(3),
      styleMap
    );
    expect(result[0]?.nodeType).toBe('continuation');
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
