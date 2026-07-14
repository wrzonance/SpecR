// src/api/header-footer-warning-openapi.test.ts
//
// #306 — header/footer capture (src/parser/docx/header-footer.ts) surfaces a
// new ParseWarning type ('header-footer-content-skipped') and a new
// SpecTree.headerFooter field (HeaderFooterComposition, ADR-040/#302).
// openapi.yaml is the hand-authored, live contract (ADR-026); this file pins
// two structural invariants a future edit could silently violate:
//
//   1. The new enum literal is documented at exactly one site — the shared
//      ParseWarning.type enum — never duplicated as an inline copy on some
//      other schema, and never missing. Checked against the *raw* source
//      text (not the $ref-dereferenced doc, where every operation that
//      references ParseWarning would inline a copy and make a naive count
//      meaningless).
//   2. SpecTree.headerFooter is wired to the existing HeaderFooterComposition
//      component via $ref, matching the hiddenTables/RetainedTable sibling
//      pattern already on SpecTree.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

const SPEC_PATH = fileURLToPath(new URL('../../openapi.yaml', import.meta.url));
const WARNING_LITERAL = 'header-footer-content-skipped';

const SchemasSchema = z.object({
  components: z.object({
    schemas: z.object({
      ParseWarning: z.object({
        properties: z.object({
          type: z.object({ enum: z.array(z.string()) }),
        }),
      }),
      SpecTree: z.object({
        properties: z.record(z.string(), z.unknown()),
      }),
    }),
  }),
});

function countOccurrences(text: string, literal: string): number {
  return text.split(literal).length - 1;
}

describe('openapi.yaml — header/footer capture warning + field (#306)', () => {
  it('documents header-footer-content-skipped at exactly one site in the raw source', () => {
    const text = readFileSync(SPEC_PATH, 'utf-8');
    expect(
      countOccurrences(text, WARNING_LITERAL),
      `expected exactly one "${WARNING_LITERAL}" site in openapi.yaml`
    ).toBe(1);
  });

  it('ParseWarning.type enum includes header-footer-content-skipped', async () => {
    const raw = await loadRawSpec();
    const { ParseWarning } = SchemasSchema.parse(raw).components.schemas;
    expect(ParseWarning.properties.type.enum).toContain(WARNING_LITERAL);
  });

  it('SpecTree.headerFooter references the HeaderFooterComposition component', async () => {
    const raw = await loadRawSpec();
    const { SpecTree } = SchemasSchema.parse(raw).components.schemas;
    const headerFooter = z
      .object({ allOf: z.array(z.object({ $ref: z.string() })) })
      .parse(SpecTree.properties['headerFooter']);
    expect(headerFooter.allOf[0]?.$ref).toBe('#/components/schemas/HeaderFooterComposition');
  });
});
