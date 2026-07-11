import { describe, it, expect } from 'vitest';
import type { ClassifiedParagraph, DocxParagraph } from './types.js';
import { NodeTypeSchema, StyleNodeTypeSchema, ParseWarningTypeSchema } from '../../ast/schemas.js';

// Boundary invariants for #292's ClassifiedParagraph.suppressed field (Phase 2 of 4:
// asterisk-rule note regions). `suppressed` marks a paragraph that produces NO SpecNode
// at all (dropped by buildTree before tree assembly) — distinct in kind from isVanish
// (a retained node hidden via meta.vanish) and isNote (a retained node rendered as
// [NOTE]). This file pins that the field is purely additive: it does not ripple into
// NodeType, StyleNodeType, ParseWarningType, or existing construction sites.

function makePara(overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text: '', isVanish: false, ...overrides };
}

function makeClassified(overrides: Partial<ClassifiedParagraph> = {}): ClassifiedParagraph {
  return {
    paragraph: makePara(),
    resolvedIlvl: 0,
    nodeType: 'part',
    signalUsed: 1,
    conflicts: [],
    agreed: [],
    isVanish: false,
    ...overrides,
  };
}

describe('ClassifiedParagraph.suppressed', () => {
  it('is absent on a paragraph built with no override — existing construction sites unaffected', () => {
    const cp = makeClassified();
    expect(cp.suppressed).toBeUndefined();
  });

  it('accepts true for a rule-row paragraph', () => {
    const cp: ClassifiedParagraph = {
      paragraph: makePara({ text: '*****' }),
      resolvedIlvl: 0,
      nodeType: 'continuation',
      signalUsed: 3,
      conflicts: [],
      agreed: [],
      isVanish: false,
      suppressed: true,
    };
    expect(cp.suppressed).toBe(true);
  });

  it('is orthogonal to isVanish and isNote — a suppressed row need not set either', () => {
    const cp = makeClassified({ suppressed: true, isVanish: false });
    expect(cp.suppressed).toBe(true);
    expect(cp.isVanish).toBe(false);
    expect(cp.isNote).toBeUndefined();
  });
});

describe('ClassifiedParagraph.suppressed — no ripple into AST-level shapes', () => {
  it('NodeType is unchanged (no "suppressed" member added)', () => {
    expect(NodeTypeSchema.options).toEqual([
      'spec',
      'part',
      'article',
      'pr1',
      'pr2',
      'pr3',
      'pr4',
      'pr5',
      'pr6',
      'pr7',
      'note',
      'continuation',
    ]);
  });

  it('StyleNodeType is unchanged (no "suppressed" member added)', () => {
    expect(StyleNodeTypeSchema.options).toEqual([
      'part',
      'article',
      'pr1',
      'pr2',
      'pr3',
      'pr4',
      'pr5',
      'pr6',
      'pr7',
    ]);
  });

  it('ParseWarningType is unchanged (no "suppressed" member added)', () => {
    expect(ParseWarningTypeSchema.options).toEqual([
      'root-continuation',
      'empty-part',
      'no-structure-found',
      'unusual-part-count',
      'non-conforming-part-numbering',
      'core-metadata-unreadable',
      'pdf-degraded-extraction',
      'pdf-ocr-applied',
      'pdf-ocr-low-confidence',
      'pdf-ocr-unusable',
      'pdf-font-encoding-remapped',
      'pdf-font-encoding-unrecoverable',
    ]);
  });
});
