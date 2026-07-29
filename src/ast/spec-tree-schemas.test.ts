import { describe, it, expect } from 'vitest';
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
  // rejected, never warned (the same class of bug PR #536 found for
  // pageSize). Exercises the REAL, production `SpecNodeMetaSchema` on both
  // sides of the mechanism it documents — unlike a decoy stand-in schema,
  // this fails if a future PR ever removes `originParagraphId` from
  // SpecNodeMetaSchema while leaving it declared on SpecNodeMeta (ast/types.ts).
  it('a mirrored key (originParagraphId) survives SpecNodeMetaSchema validation; an unmirrored key is silently dropped (PR #536 failure mode)', () => {
    const parsed = SpecNodeMetaSchema.parse({
      vanish: true,
      originParagraphId: VALID_ORIGIN_UUID,
      notMirroredIntoSchema: 'a hypothetical future field with no Zod counterpart',
    });
    expect(parsed.originParagraphId).toBe(VALID_ORIGIN_UUID);
    expect('notMirroredIntoSchema' in parsed).toBe(false);
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
