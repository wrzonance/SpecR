import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SpecNodeMetaSchema, SpecTreeSchema } from './spec-tree-schemas.js';

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ORIGIN_UUID = '660e8400-e29b-41d4-a716-446655440001';
const VALID_SECTION = '27 21 00';

// originParagraphId (#392, ADR-078): the live paragraph UUID a frozen node was
// snapshotted from, written only by `snapshotMemberTrees` at revision-freeze
// time. Additive-only on SpecNodeMeta/SpecNodeMetaSchema — no other module
// depends on it yet (this file pins the AST-boundary contract in isolation).
describe('SpecNodeMetaSchema — originParagraphId (#392)', () => {
  it('omits originParagraphId when absent (no default injected)', () => {
    const result = SpecNodeMetaSchema.parse({});
    expect('originParagraphId' in result).toBe(false);
  });

  it('preserves originParagraphId through validation when present', () => {
    const result = SpecNodeMetaSchema.parse({ originParagraphId: VALID_ORIGIN_UUID });
    expect(result.originParagraphId).toBe(VALID_ORIGIN_UUID);
  });

  it('rejects a non-uuid originParagraphId', () => {
    expect(() => SpecNodeMetaSchema.parse({ originParagraphId: 'not-a-uuid' })).toThrow();
  });

  // Mirrors the pageSize/pageBreakBefore exactOptional regression guard:
  // distinguishes "key absent" from "key present with value undefined"
  // (exactOptionalPropertyTypes, CLAUDE.md).
  it('rejects an explicit originParagraphId: undefined (exactOptional, not optional)', () => {
    const result = SpecNodeMetaSchema.safeParse({ originParagraphId: undefined });
    expect(result.success).toBe(false);
  });

  // #392 spike finding: SpecNodeMetaSchema has no `.catchall()`, so ANY key
  // present on the SpecNodeMeta TS type but not mirrored into the Zod shape
  // is silently stripped by z.object() on every validation pass — never
  // rejected, never warned. This reproduces the exact failure mode the #392
  // spike hit when it first tried originParagraphId without this mirror
  // (the same class of bug PR #536 found for pageSize): a decoy schema
  // missing the field demonstrates the drop directly, so a future field
  // added to SpecNodeMeta without its Zod counterpart is provably silent —
  // motivating why the mirror step is mandatory, not tidiness.
  it('demonstrates the catchall-drop an unmirrored meta key silently hits (PR #536 failure mode)', () => {
    const unmirroredMetaSchema = z.object({ vanish: z.boolean().exactOptional() });
    const parsed = unmirroredMetaSchema.parse({
      vanish: true,
      originParagraphId: VALID_ORIGIN_UUID,
    });
    expect('originParagraphId' in parsed).toBe(false);
  });
});

describe('SpecTreeSchema — originParagraphId round-trips through a node tree (#392)', () => {
  const base = { id: VALID_UUID, section: VALID_SECTION, title: 'Cabling', parts: [] };
  const frozenNode = {
    id: VALID_UUID,
    type: 'part' as const,
    text: 'PART 1 GENERAL',
    children: [],
    meta: { originParagraphId: VALID_ORIGIN_UUID },
  };

  it('round-trips originParagraphId on a frozen node', () => {
    const result = SpecTreeSchema.parse({ ...base, parts: [frozenNode] });
    expect(result.parts[0]?.meta.originParagraphId).toBe(VALID_ORIGIN_UUID);
  });

  it('omits originParagraphId on a live node (absent, never a null placeholder)', () => {
    const liveNode = { ...frozenNode, meta: {} };
    const result = SpecTreeSchema.parse({ ...base, parts: [liveNode] });
    expect('originParagraphId' in (result.parts[0]?.meta ?? {})).toBe(false);
  });
});
