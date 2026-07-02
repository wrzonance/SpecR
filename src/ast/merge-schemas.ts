import { z } from 'zod';

// Request-body schema for applying an accepted merge (POST /specs/:id/merge and the
// apply_merge MCP tool). The nested DiffResultSchema mirrors the merge module's
// DiffResult (src/merge/types.ts) — the shape get_spec_diff returns.

const ParagraphDiffSchema = z.object({
  uuid: z.uuid(),
  text: z.string(),
  index: z.number().int().min(0),
});

const ModifiedDiffSchema = z.object({
  uuid: z.uuid(),
  base: z.string(),
  theirs: z.string(),
  ours: z.string(),
});

export const DiffResultSchema = z.object({
  added: z.array(ParagraphDiffSchema),
  modified: z.array(ModifiedDiffSchema),
  deleted: z.array(z.uuid()),
  conflicts: z.array(ModifiedDiffSchema),
  warnings: z.array(z.string()),
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
