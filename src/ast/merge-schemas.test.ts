import { describe, it, expect } from 'vitest';
import { DiffResultSchema } from './merge-schemas.js';

// Pins the cross-bucket uuid-uniqueness refinement (#374). applyAccepted builds a
// uuid→change map by spreading modified/conflicts/added/deleted; a client-supplied
// duplicate would last-win silently (deleted shadowing an accepted modified → an
// edit becomes a removal). The refinement rejects it at the parse boundary, so both
// the REST body and the MCP tool input fail before applyAccepted ever runs.

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

describe('DiffResultSchema — cross-bucket uuid uniqueness (#374)', () => {
  it('rejects a uuid present in both modified and deleted (an accepted edit must not silently become a removal)', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [U1],
      conflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes(U1))).toBe(true);
    }
  });

  it('rejects a uuid shared across added and conflicts', () => {
    const result = DiffResultSchema.safeParse({
      added: [{ uuid: U1, text: 'x', index: 0 }],
      modified: [],
      deleted: [],
      conflicts: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case-variant duplicate across buckets (UUIDs are case-insensitive — same row)', () => {
    // z.uuid() accepts either case and PostgreSQL treats "ABC…" and "abc…" as the
    // same uuid row, so a case-only difference must not slip a duplicate past the
    // cross-bucket guard (otherwise one paragraph gets both an edit and a removal).
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [{ uuid: U1.toUpperCase(), base: 'b', theirs: 't', ours: 'o' }],
      deleted: [U1],
      conflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a diff whose buckets use distinct uuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [{ uuid: U1, text: 'x', index: 0 }],
      modified: [{ uuid: U2, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [],
      conflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });
});
