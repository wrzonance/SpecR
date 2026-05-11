import { describe, it, expect } from 'vitest';
import { classifyParagraphs } from './inference.js';
import { emptyNumberingMap } from './numbering.js';
import type { DocxParagraph, NumberingMap, StyleMap } from './types.js';

function emptyStyleMap(): StyleMap {
  return { styles: new Map(), resolvedNumPr: new Map() };
}

function makePara(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text: '', isVanish: false, ...overrides };
}

const numMap = (articleIlvl = 1): NumberingMap => ({ ...emptyNumberingMap(), articleIlvl });

describe('classifyParagraphs — signal 1 (numId+ilvl)', () => {
  it('ARCAT-style ilvl=0 → part, normalizedIlvl=0', () => {
    const result = classifyParagraphs(
      [makePara({ numId: 1, ilvl: 0 })],
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
      [makePara({ numId: 1, ilvl: 0, isVanish: true })],
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
