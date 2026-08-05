import { describe, it, expect } from 'vitest';
import { DiffResultSchema, MergeBodySchema } from './merge-schemas.js';
import type { DiffResult } from '../merge/index.js';

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
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [],
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
      deleteConflicts: [],
      conflicts: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      objectConflicts: [],
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
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a diff whose buckets use distinct uuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [{ uuid: U1, text: 'x', index: 0 }],
      modified: [{ uuid: U2, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });
});

// ── DiffResultSchema — objectConflicts (#520) ───────────────────────────────
const OBJ1 = '33333333-3333-4333-8333-333333333333';
const TABLE_FINGERPRINT_BASE = { kind: 'table' as const, rows: 2, columns: 2, hash: 'a' };
const TABLE_FINGERPRINT_THEIRS = { kind: 'table' as const, rows: 3, columns: 2, hash: 'b' };

describe('DiffResultSchema — objectConflicts (#520)', () => {
  it('parses an objectConflicts entry, rows/columns omittable for a textBox kind', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: { kind: 'textBox', hash: 'a' },
          theirs: { kind: 'textBox', hash: 'b' },
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a uuid shared across modified and objectConflicts.affectedUuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: TABLE_FINGERPRINT_BASE,
          theirs: TABLE_FINGERPRINT_THEIRS,
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes(U1))).toBe(true);
    }
  });

  it('rejects a uuid shared across deleted and objectConflicts.affectedUuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [U1],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: TABLE_FINGERPRINT_BASE,
          theirs: TABLE_FINGERPRINT_THEIRS,
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a uuid shared across conflicts and objectConflicts.affectedUuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      deleteConflicts: [],
      conflicts: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: TABLE_FINGERPRINT_BASE,
          theirs: TABLE_FINGERPRINT_THEIRS,
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case-variant duplicate between deleted and objectConflicts.affectedUuids', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [U1.toUpperCase()],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: TABLE_FINGERPRINT_BASE,
          theirs: TABLE_FINGERPRINT_THEIRS,
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects the object conflict's own objectId reused as a modified uuid", () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [{ uuid: OBJ1, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [],
      deleteConflicts: [],
      conflicts: [],
      objectConflicts: [
        {
          objectId: OBJ1,
          affectedUuids: [U1],
          base: TABLE_FINGERPRINT_BASE,
          theirs: TABLE_FINGERPRINT_THEIRS,
        },
      ],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });
});

// ── DiffResultSchema — deleteConflicts (#465) ───────────────────────────────
// Pins the boundary invariant between DeleteConflictDiff (src/merge/types.ts)
// and DeleteConflictDiffSchema (this file): every field one requires, the
// other requires and identically types, so a parsed diff is directly
// assignable to DiffResult with zero adapter — the same guarantee the
// existing objectConflicts suite above pins for ObjectConflictDiff.
const DELETE_CONFLICT_DIFF = { uuid: U1, base: 'base text', ours: 'writer edit' };

describe('DiffResultSchema — deleteConflicts (#465)', () => {
  it('rejects a diff that omits deleteConflicts entirely (the field is required, not optional)', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('parses a deleteConflicts entry carrying uuid/base/ours, no theirs key required', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      deleteConflicts: [DELETE_CONFLICT_DIFF],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // A parsed entry has no `theirs` key at all — matches DeleteConflictDiff's
      // deliberate omission (never an empty-string sentinel).
      expect(result.data.deleteConflicts[0]).not.toHaveProperty('theirs');
      // Assignability check: the parsed output is directly usable as a DiffResult
      // with zero adapter — if DeleteConflictDiffSchema's inferred shape ever
      // drifted from DeleteConflictDiff (a field renamed, retyped, or an extra
      // required key added to one but not the other), this line fails to compile.
      const diff: DiffResult = result.data;
      expect(diff.deleteConflicts).toHaveLength(1);
    }
  });

  it('rejects a deleteConflicts entry missing `ours`', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      deleteConflicts: [{ uuid: U1, base: 'base text' }],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a deleteConflicts entry missing `base`', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [],
      deleteConflicts: [{ uuid: U1, ours: 'writer edit' }],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a uuid shared across deleted and deleteConflicts', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [U1],
      deleteConflicts: [DELETE_CONFLICT_DIFF],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes(U1))).toBe(true);
    }
  });

  it('rejects a uuid shared across modified and deleteConflicts', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [{ uuid: U1, base: 'b', theirs: 't', ours: 'o' }],
      deleted: [],
      deleteConflicts: [DELETE_CONFLICT_DIFF],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a case-variant duplicate between deleted and deleteConflicts (UUIDs are case-insensitive)', () => {
    const result = DiffResultSchema.safeParse({
      added: [],
      modified: [],
      deleted: [U1.toUpperCase()],
      deleteConflicts: [DELETE_CONFLICT_DIFF],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a deleteConflicts entry alongside distinct uuids in every other bucket', () => {
    const result = DiffResultSchema.safeParse({
      added: [{ uuid: U2, text: 'x', index: 0 }],
      modified: [],
      deleted: [],
      deleteConflicts: [DELETE_CONFLICT_DIFF],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });
});

// ── MergeBodySchema — actorLabel passthrough (#377) ─────────────────────────
const EMPTY_DIFF = {
  added: [],
  modified: [],
  deleted: [],
  deleteConflicts: [],
  conflicts: [],
  objectConflicts: [],
  warnings: [],
};

describe('MergeBodySchema — actorLabel (#377)', () => {
  it('omitting actorLabel parses byte-identical to the pre-#377 shape', () => {
    expect(MergeBodySchema.parse({ accept: [], diff: EMPTY_DIFF })).toEqual({
      accept: [],
      diff: EMPTY_DIFF,
    });
  });
  it('accepts an explicit actorLabel', () => {
    expect(MergeBodySchema.parse({ accept: [], diff: EMPTY_DIFF, actorLabel: 'jane.doe' })).toEqual(
      { accept: [], diff: EMPTY_DIFF, actorLabel: 'jane.doe' }
    );
  });
  it('rejects a whitespace-only actorLabel', () => {
    expect(
      MergeBodySchema.safeParse({ accept: [], diff: EMPTY_DIFF, actorLabel: '  ' }).success
    ).toBe(false);
  });
});
