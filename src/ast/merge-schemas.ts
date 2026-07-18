import { z } from 'zod';
import { ActorLabelSchema } from './actor-schemas.js';
import { ObjectKindSchema } from './object-schemas.js';

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

// Mirrors ObjectStructureFingerprint (src/merge/object-fingerprint.ts). rows/columns
// MUST be `.exactOptional()`, not `.optional()` — under this repo's
// `exactOptionalPropertyTypes`, `.optional()` infers `rows?: number | undefined`,
// which is NOT assignable to the TS interface's `rows?: number` (its value type
// excludes `undefined`; only the key is optional). `.exactOptional()` infers the
// matching `rows?: number` shape, so the parsed diff is directly assignable to
// DiffResult with zero adapter — the same pattern ObjectMetaSchema already uses
// for the identical rows/columns fields (src/ast/object-schemas.ts).
const ObjectStructureFingerprintSchema = z.object({
  kind: ObjectKindSchema,
  rows: z.number().int().nonnegative().exactOptional(),
  columns: z.number().int().nonnegative().exactOptional(),
  hash: z.string(),
});

// Mirrors ObjectConflictDiff (src/merge/types.ts) — one atomic structural conflict
// on a body-level table/text box (#520): detection-only, an accept always rejects
// (validateAccepted, src/merge/conflict.ts).
const ObjectConflictDiffSchema = z.object({
  objectId: z.uuid(),
  affectedUuids: z.array(z.uuid()),
  base: ObjectStructureFingerprintSchema,
  theirs: ObjectStructureFingerprintSchema,
});

export const DiffResultSchema = z
  .object({
    added: z.array(ParagraphDiffSchema),
    modified: z.array(ModifiedDiffSchema),
    deleted: z.array(z.uuid()),
    conflicts: z.array(ModifiedDiffSchema),
    // Atomic structural conflicts on body-level tables/text boxes (#520) —
    // required, not optional: computeDiff always populates it (possibly []), and
    // a client only ever resubmits what get_spec_diff just returned it, so the
    // wire shape mirrors DiffResult exactly rather than tolerating a stale caller.
    objectConflicts: z.array(ObjectConflictDiffSchema),
    warnings: z.array(z.string()),
  })
  // A uuid must classify as exactly ONE change kind. computeDiff never emits a
  // uuid in two buckets, but applyAccepted builds a uuid→change map by spreading
  // modified/conflicts/added/deleted/objectConflicts in order, so a
  // client-supplied duplicate would silently last-win (e.g. deleted shadowing an
  // accepted modified → an edit becomes a removal). Reject it at the parse
  // boundary instead (#374, extended to objectConflicts by #520).
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
          message: `duplicate diff uuid ${uuid} in bucket "${bucket}" — a uuid must appear in exactly one of modified/conflicts/added/deleted/objectConflicts`,
        });
        return;
      }
      seen.add(key);
    };
    diff.modified.forEach((c) => visit(c.uuid, 'modified'));
    diff.conflicts.forEach((c) => visit(c.uuid, 'conflicts'));
    diff.added.forEach((c) => visit(c.uuid, 'added'));
    diff.deleted.forEach((u) => visit(u, 'deleted'));
    // Both the object row's own id and each affected child anchor are excluded
    // from every other bucket by computeDiff's classifyBase (src/merge/diff.ts)
    // — mirror that exclusion here so a client-supplied diff can't reintroduce
    // one under a text-change bucket and slip it past validateAccepted's
    // atomic-conflict rejection (src/merge/conflict.ts).
    diff.objectConflicts.forEach((c) => {
      visit(c.objectId, 'objectConflicts.objectId');
      c.affectedUuids.forEach((uuid) => visit(uuid, 'objectConflicts.affectedUuids'));
    });
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
  // #377 — caller-supplied actor identity, attributed on every history row this
  // merge writes; omitted falls back to the SYSTEM_ACTOR_LABEL sentinel. Plain
  // `.optional()` (not `.exactOptional()`) matches expectedVersion above — this
  // shape is consumed by destructuring individual fields (REST + MCP handlers),
  // never passed through as a whole object, so exactOptionalPropertyTypes is a
  // non-issue here.
  actorLabel: ActorLabelSchema.optional().describe(
    'Caller identity attributed to this merge in paragraph history; omitted falls back to a system sentinel'
  ),
};

// REST body is strict (unknown keys rejected); specId travels in the path, not the body.
export const MergeBodySchema = z.strictObject(MergeFieldsShape);
export type MergeBody = z.infer<typeof MergeBodySchema>;
