import { pool, findSpecById, assertSpecWritable } from '../db/index.js';
import { applyAccepted, type ApplyAcceptedResult } from './conflict.js';
import type { DiffResult } from './types.js';

export type ApplyMergeOutcome =
  | { readonly kind: 'not-found' }
  | ({ readonly kind: 'applied' } & ApplyAcceptedResult);

/**
 * Apply an accepted-changes merge to a spec inside one transaction: the composed
 * edit gate + optimistic precondition (ADR-018), applyAccepted, and the
 * content_version bump. Shared by the REST merge handler and the apply_merge MCP
 * tool so the orchestration lives in one place. Throws the merge/gate errors
 * (StaleVersionError, SpecWriteForbiddenError, InvalidAcceptedChangeError,
 * MergeError) for the caller to map; a missing spec returns { kind: 'not-found' }.
 */
export async function applyMerge(
  specId: string,
  accept: readonly string[],
  diff: DiffResult,
  expectedVersion: number | undefined
): Promise<ApplyMergeOutcome> {
  const spec = await findSpecById(specId);
  if (!spec) return { kind: 'not-found' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A merge mutates content, so it is governed exactly like a paragraph write.
    await assertSpecWritable(client, specId, expectedVersion);
    const result = await applyAccepted(specId, accept, diff, client);
    // Only advance the optimistic-concurrency token when content actually changed:
    // a no-op merge (applied === 0) must not bump content_version, or it would
    // invalidate every other client's precondition and trigger avoidable 409s.
    if (result.applied > 0) {
      await client.query(
        `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
        [specId]
      );
    }
    await client.query('COMMIT');
    return { kind: 'applied', ...result };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}
