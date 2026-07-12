import { describe, it, expect } from 'vitest';
import { NodeTypeSchema, ParseWarningTypeSchema } from '../../ast/schemas.js';
import { StyleNodeTypeSchema } from '../../ast/style-schemas.js';

// Boundary invariants for #292's ClassifiedParagraph.suppressed field (Phase 2 of 4:
// asterisk-rule note regions). `suppressed` marks a paragraph that produces NO SpecNode
// at all (dropped by buildTree before tree assembly) — distinct in kind from isVanish
// (a retained node hidden via meta.vanish) and isNote (a retained node rendered as
// [NOTE]). This file pins that the field is purely additive: it does not ripple into
// NodeType, StyleNodeType, or ParseWarningType.
//
// The runtime construction/orthogonality invariants (a rule row IS suppressed; a
// suppressed row need not also set isVanish/isNote; a suppressed row's
// isVanish/suppressed combination survives classification and mergeProfileConflicts)
// are pinned at the real production boundary — classifyParagraphs/buildTree in
// inference-notes.test.ts and mergeProfileConflicts in numbering-profile-apply.test.ts
// — not here. A hand-built ClassifiedParagraph literal that only asserts on the values
// it was just constructed with exercises no production code and cannot fail on a real
// regression (previously discovered: such a literal even asserted an invariant, isNote
// left undefined, that production's rule-row branch does not actually produce — it
// sets isNote: false explicitly. See src/parser/docx/types.ts for the field's
// documented shape).

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
      'table-content-skipped',
    ]);
  });
});
