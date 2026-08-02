import {
  pool,
  findSpecById,
  assertSpecWritable,
  bumpSpecContentVersion,
  lazyHistoryContext,
} from '../db/index.js';
import { applyAccepted, type ApplyAcceptedResult } from './conflict.js';
import type { DiffResult } from './types.js';

export type ApplyMergeOutcome =
  { readonly kind: 'not-found' } | ({ readonly kind: 'applied' } & ApplyAcceptedResult);

/**
 * Apply an accepted-changes merge to a spec inside one transaction: the composed
 * edit gate + optimistic precondition (ADR-018), applyAccepted, and the
 * content_version bump. Shared by the REST merge handler and the apply_merge MCP
 * tool so the orchestration lives in one place. Throws the merge/gate errors
 * (StaleVersionError, SpecWriteForbiddenError, InvalidAcceptedChangeError,
 * MergeError) for the caller to map; a missing spec returns { kind: 'not-found' }.
 *
 * `actorLabel` (#377, ADR-052 D1) attributes every paragraph_versions snapshot
 * this merge writes; falls back to the SYSTEM_ACTOR_LABEL sentinel
 * (paragraph-history.ts) when omitted. The history context is resolved
 * lazily (lazyHistoryContext) — only on the first change applyAccepted
 * confirms is actually effective, mirroring applyVanish/runInsert/runAccept's
 * own "resolve past the no-op guard" contract — so a merge that ends up
 * writing nothing (empty accept array, or every accepted change already
 * matches) never upserts a users row for actorLabel. Every snapshot this
 * call DOES make still shares one content_version generation and one
 * resolved actor, since the resolver memoizes after its first call.
 */
export async function applyMerge(
  specId: string,
  accept: readonly string[],
  diff: DiffResult,
  expectedVersion: number | undefined,
  actorLabel?: string
): Promise<ApplyMergeOutcome> {
  const spec = await findSpecById(specId);
  if (!spec) return { kind: 'not-found' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A merge mutates content, so it is governed exactly like a paragraph write.
    // The returned contentVersion is the pre-bump generation this write belongs to.
    const gate = await assertSpecWritable(client, specId, expectedVersion);
    const resolveHistory = lazyHistoryContext(client, gate.contentVersion, actorLabel);
    const result = await applyAccepted(specId, accept, diff, client, resolveHistory);
    // Only advance the optimistic-concurrency token when content actually changed:
    // a no-op merge (applied === 0) must not bump content_version, or it would
    // invalidate every other client's precondition and trigger avoidable 409s.
    if (result.applied > 0) {
      await bumpSpecContentVersion(client, specId);
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
