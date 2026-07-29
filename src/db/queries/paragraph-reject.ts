import { pool, DatabaseError, updateParagraphText, getParagraphSpecId } from '../index.js';
import { getCheckpointBoundariesForSpec } from './checkpoints.js';
import type { CheckpointBoundary } from './checkpoints.js';
import type { SpecNode } from '../../ast/index.js';

// ADR-052 D4 (issue #380, task 7) — per-paragraph reject: "revert pending
// edits to the last-checkpoint state," shipped as a restore-to-version write
// through the existing paragraph PATCH (updateParagraphText, paragraphs.ts).
// The revert is unconditional — it never threads expectedVersion through, so
// an edit made after the checkpoint sealed is discarded rather than blocking
// the reject with a stale-version conflict. The write is itself a normal
// 'edit' history row (recordParagraphHistory runs unconditionally inside
// updateParagraphText's transaction), so a reject is always visible in the
// oplog, never a silent no-op.

/** Outcome of {@link rejectParagraphToCheckpoint}. `not-found`, `wrong-spec`,
 *  and `locked-object` mirror {@link UpdateParagraphResult}'s non-'updated'
 *  variants verbatim — updateParagraphText's own ownership/lock checks still
 *  run on the actual write, so a race between the pre-write lookup below and
 *  the write itself still surfaces correctly.
 *
 *  `checkpoint-not-found` covers both an unknown checkpoint id and one that
 *  never sealed `specId` (its content_version_map carries no key for it) —
 *  from the caller's perspective these are indistinguishable.
 *
 *  `no-checkpointed-state` covers a paragraph with no paragraph_versions row
 *  at or before the checkpoint's contentVersion: either it was inserted
 *  after the checkpoint sealed, or every prior row predates migration 046
 *  (content_version NULL, never a join target per ADR-052 D3 amendment #2) —
 *  either way there is nothing recorded to revert to. */
export type RejectParagraphResult =
  | { readonly status: 'reverted'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'locked-object'; readonly nodeType: string }
  | { readonly status: 'checkpoint-not-found' }
  | { readonly status: 'no-checkpointed-state' };

/** The checkpoint boundary `checkpointId` represents for `specId` — spec- or
 *  project-scoped alike, whichever sealed this spec — or null when
 *  `checkpointId` names no checkpoint that ever sealed it. */
async function findCheckpointBoundary(
  specId: string,
  checkpointId: string
): Promise<CheckpointBoundary | null> {
  const boundaries = await getCheckpointBoundariesForSpec(specId);
  // pg's checkpointId (row.id) is canonical lowercase; z.uuid() preserves an
  // uppercase input — normalize both, mirroring classifyMissingSealedState's
  // specId comparison below (#380 review finding: this comparison was missed
  // when that fix landed).
  const normalized = checkpointId.toLowerCase();
  return boundaries.find((boundary) => boundary.checkpointId.toLowerCase() === normalized) ?? null;
}

interface SealedTextRow {
  readonly text: string;
}

/** The paragraph's own text as of the checkpoint's sealed contentVersion: the
 *  latest paragraph_versions row at or before the cutoff. A NULL
 *  content_version row (pre-046, unrecoverable) can never match — ADR-052 D3
 *  amendment #2's "never a join target" rule, extended from session sealing
 *  to reject's single-paragraph lookup. */
async function findSealedText(
  paragraphId: string,
  specId: string,
  contentVersionCutoff: number
): Promise<string | null> {
  const result = await pool.query<SealedTextRow>(
    `SELECT text FROM paragraph_versions
     WHERE paragraph_id = $1 AND spec_id = $2
       AND content_version IS NOT NULL AND content_version <= $3
     ORDER BY content_version DESC, version DESC, id DESC
     LIMIT 1`,
    [paragraphId, specId, contentVersionCutoff]
  );
  return result.rows[0]?.text ?? null;
}

/** Disambiguates a null {@link findSealedText} result: the paragraph may not
 *  exist at all, may belong to a different spec than `specId`, or may
 *  genuinely have no recorded state before the checkpoint. */
async function classifyMissingSealedState(
  paragraphId: string,
  specId: string
): Promise<RejectParagraphResult> {
  const owningSpecId = await getParagraphSpecId(paragraphId);
  if (!owningSpecId) return { status: 'not-found' };
  // pg lowercases spec_id; z.uuid() preserves an uppercase input — normalize both.
  if (owningSpecId.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };
  return { status: 'no-checkpointed-state' };
}

/**
 * Revert `paragraphId`'s text to the state it held at `checkpointId`'s
 * sealed contentVersion (ADR-052 D4). Looks up the checkpoint boundary for
 * `specId`, the paragraph's own snapshot at or before that boundary, then
 * writes it back through {@link updateParagraphText} with NO
 * `expectedVersion` — the revert always overwrites current text
 * unconditionally, discarding any edit made after the checkpoint rather than
 * failing on a stale-version conflict. Attributed to `actorLabel` like any
 * other paragraph write (falls back to the SYSTEM_ACTOR_LABEL sentinel
 * inside updateParagraphText's own history capture).
 */
export async function rejectParagraphToCheckpoint(
  specId: string,
  paragraphId: string,
  checkpointId: string,
  actorLabel?: string
): Promise<RejectParagraphResult> {
  try {
    const boundary = await findCheckpointBoundary(specId, checkpointId);
    if (!boundary) return { status: 'checkpoint-not-found' };

    const sealedText = await findSealedText(paragraphId, specId, boundary.contentVersion);
    // `return await` is load-bearing inside this try: without it the promise
    // settles after the catch has already exited, so a raw error would escape
    // the module boundary unwrapped.
    if (sealedText === null) return await classifyMissingSealedState(paragraphId, specId);

    const result = await updateParagraphText(
      specId,
      paragraphId,
      sealedText,
      undefined,
      actorLabel
    );
    return result.status === 'updated' ? { status: 'reverted', node: result.node } : result;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`rejectParagraphToCheckpoint failed for paragraph ${paragraphId}`, {
      cause: err,
    });
  }
}
