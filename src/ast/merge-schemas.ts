import { z } from 'zod';

// Request-body schema for applying an accepted merge (POST /specs/:id/merge and the
// apply_merge MCP tool). The nested DiffResultSchema mirrors the merge module's
// DiffResult (src/merge/types.ts) — the shape get_spec_diff returns.

const ParagraphDiffSchema = z.object({
  uuid: z.uuid(),
  text: z.string(),
  index: z.number().int().min(0),
  /** nearest preceding controlled uuid in document order, absent if none */
  afterUuid: z.uuid().optional(),
});

const ModifiedDiffSchema = z.object({
  uuid: z.uuid(),
  base: z.string(),
  theirs: z.string(),
  ours: z.string(),
});

export const DiffResultSchema = z
  .object({
    added: z.array(ParagraphDiffSchema),
    modified: z.array(ModifiedDiffSchema),
    deleted: z.array(z.uuid()),
    conflicts: z.array(ModifiedDiffSchema),
    warnings: z.array(z.string()),
  })
  // A uuid must classify as exactly ONE change kind. computeDiff never emits a
  // uuid in two buckets, but applyAccepted builds a uuid→change map by spreading
  // modified/conflicts/added/deleted in order, so a client-supplied duplicate
  // would silently last-win (e.g. deleted shadowing an accepted modified → an
  // edit becomes a removal). Reject it at the parse boundary instead (#374).
  .superRefine((diff, ctx) => {
    const seen = new Set<string>();
    // UUIDs are case-insensitive: z.uuid() accepts either case and PostgreSQL's
    // uuid type stores/compares them canonically, so "ABC…" and "abc…" are the
    // same row. Compare on a case-folded key or a client could evade this check
    // with a case-variant duplicate (edit "ABC…" + delete "abc…" → one row, two
    // change kinds).
    const visit = (uuid: string, bucket: string): void => {
      const key = uuid.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate diff uuid ${uuid} in bucket "${bucket}" — a uuid must appear in exactly one of modified/conflicts/added/deleted`,
        });
        return;
      }
      seen.add(key);
    };
    diff.modified.forEach((c) => visit(c.uuid, 'modified'));
    diff.conflicts.forEach((c) => visit(c.uuid, 'conflicts'));
    diff.added.forEach((c) => visit(c.uuid, 'added'));
    diff.deleted.forEach((u) => visit(u, 'deleted'));
  });

// Shared field shape so REST (strict body) and the MCP tool (which also carries specId)
// validate identical merge fields — the big DiffResultSchema lives in exactly one place.
export const MergeFieldsShape = {
  accept: z.array(z.uuid()).describe('UUIDs of the diff changes to accept (from get_spec_diff)'),
  diff: DiffResultSchema.describe('The DiffResult previously returned by get_spec_diff'),
  expectedVersion: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optimistic-concurrency precondition — the contentVersion the diff was computed against; a stale value is rejected'
    ),
};

// REST body is strict (unknown keys rejected); specId travels in the path, not the body.
export const MergeBodySchema = z.strictObject(MergeFieldsShape);
export type MergeBody = z.infer<typeof MergeBodySchema>;
