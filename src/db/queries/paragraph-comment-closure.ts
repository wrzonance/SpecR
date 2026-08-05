import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import { bumpSpecContentVersion } from './content-version.js';
import { recordParagraphHistory, resolveHistoryContext } from './paragraph-history.js';
import { SourceFactsSchema } from '../../ast/index.js';
import type { PoolClient } from 'pg';
import type { SourceFacts, SpecNode } from '../../ast/index.js';
import { fetchSubtreeNode } from './paragraphs.js';

// #545, ADR-079 follow-on: a mutable comment-closure toggle, closing the
// readiness gate's "no supported API path to clear open_comment" gap.
// Deliberately named `paragraph-comment-closure.ts`, NOT `comment-closure.ts`
// — that basename is already owned by two unrelated read-only modules
// (src/parser/docx/comment-closure.ts, src/ast/comment-closure.ts) that
// derive closure at parse time; this file is the write path over the
// persisted fact those modules only ever produce once, at import.

/**
 * Pure: returns a NEW SourceFacts with `comments[index].closed` set,
 * every other key/entry untouched. `null` when there is no comment at
 * `index` to close/reopen — the caller maps that to a `no-comment` outcome.
 * Never mutates `facts`.
 */
export function deriveCommentClosureFacts(
  facts: SourceFacts,
  index: number,
  closed: boolean
): SourceFacts | null {
  const comments = facts.comments;
  const target = comments?.[index];
  if (!comments || !target) return null;
  const nextComments = comments.map((comment, i) =>
    i === index ? { ...comment, closed } : comment
  );
  return { ...facts, comments: nextComments };
}

/** Outcome of {@link setParagraphCommentClosed}: the (specId, nodeId)
 *  pairing is validated before the write so the API maps `not-found` → 404,
 *  `wrong-spec` → 403, and `no-comment` → 404 (a lookup miss — nothing
 *  exists at this index to toggle, distinct from a validation failure). */
export type SetCommentClosedResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'no-comment' };

/** Outcome of {@link setCommentClosedRow}. Widens the public
 *  {@link SetCommentClosedResult}'s `updated` branch with the pre-toggle
 *  image the caller needs to snapshot a history row without a second
 *  `FOR UPDATE` round-trip. */
export type SetCommentClosedRowResult =
  | {
      readonly status: 'updated';
      readonly node: SpecNode;
      readonly changed: boolean;
      readonly previousText: string;
      readonly previousNodeType: string;
      readonly previousBaseVersion: number;
    }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'no-comment' };

/**
 * The reusable DB core behind {@link setParagraphCommentClosed} AND
 * `reclassify.ts`'s `runAccept` (which closes the originating comment as
 * part of accepting it as a note — the sharpest symptom in #545): lock the
 * row, validate ownership and comment existence, and toggle
 * `comments[index].closed` — a no-op when it already matches.
 *
 * Deliberately gate-free and bump-free: the caller owns both the edit gate
 * and the `content_version` bump, mirroring `setVanishRow`/`setAcknowledgedRow`.
 */
export async function setCommentClosedRow(
  client: PoolClient,
  specId: string,
  nodeId: string,
  index: number,
  closed: boolean
): Promise<SetCommentClosedRowResult> {
  const owner = await client.query<{
    spec_id: string;
    node_type: string;
    source_facts: unknown;
    text: string;
    base_version: number;
  }>(
    `SELECT spec_id, node_type, source_facts, text, base_version
     FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) return { status: 'not-found' };
  if (ownerRow.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };

  const facts = SourceFactsSchema.parse(ownerRow.source_facts);
  const comment = facts.comments?.[index];
  if (!comment) return { status: 'no-comment' };

  const changed = comment.closed !== closed;
  if (changed) {
    const nextFacts = deriveCommentClosureFacts(facts, index, closed);
    if (!nextFacts) return { status: 'no-comment' };
    await client.query(
      `UPDATE paragraphs SET source_facts = $2::jsonb, base_version = base_version + 1, updated_at = now()
       WHERE id = $1`,
      [nodeId, JSON.stringify(nextFacts)]
    );
  }

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('setCommentClosedRow: updated node vanished mid-transaction');
  return {
    status: 'updated',
    node,
    changed,
    previousText: ownerRow.text,
    previousNodeType: ownerRow.node_type,
    previousBaseVersion: ownerRow.base_version,
  };
}

/** In-transaction body of {@link setParagraphCommentClosed}: gate → delegate
 *  the toggle to {@link setCommentClosedRow} → snapshot the pre-toggle image
 *  under op `'close-comment'`/`'reopen-comment'` → bump `content_version`
 *  once, only on an effective ('changed') write. */
async function applyCommentClosed(
  client: PoolClient,
  specId: string,
  nodeId: string,
  index: number,
  closed: boolean,
  actorLabel?: string
): Promise<SetCommentClosedResult> {
  const gate = await assertSpecWritable(client, specId);

  const result = await setCommentClosedRow(client, specId, nodeId, index, closed);
  if (result.status !== 'updated') return result;

  if (result.changed) {
    const historyContext = await resolveHistoryContext(client, gate.contentVersion, actorLabel);
    await recordParagraphHistory(client, {
      paragraphId: nodeId,
      specId,
      version: result.previousBaseVersion + 1,
      text: result.previousText,
      nodeType: result.previousNodeType,
      op: closed ? 'close-comment' : 'reopen-comment',
      contentVersion: historyContext.contentVersion,
      userId: historyContext.userId,
      payload: null,
    });
    await bumpSpecContentVersion(client, specId);
  }

  return { status: 'updated', node: result.node };
}

/**
 * Close or reopen a source-document review comment on an existing spec by
 * (nodeId, index) (#545, ADR-079 follow-on): the only supported path to
 * clear `open_comment` — until this, `comments[*].closed` was a parse-time-
 * only fact no write path ever touched. Passes the composed edit gate
 * (ADR-018). The toggle is idempotent — a no-op leaves the row untouched; an
 * effective change bumps `specs.content_version` and snapshots a
 * `paragraph_versions` row under op `'close-comment'`/`'reopen-comment'`,
 * attributed to `actorLabel` (falls back to the SYSTEM_ACTOR_LABEL sentinel
 * when omitted). `no-comment` when `index` is out of range for the node's
 * `source_facts.comments` (→ 404, a lookup miss).
 */
export async function setParagraphCommentClosed(
  specId: string,
  nodeId: string,
  index: number,
  closed: boolean,
  actorLabel?: string
): Promise<SetCommentClosedResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyCommentClosed(client, specId, nodeId, index, closed, actorLabel);
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setParagraphCommentClosed failed', { cause: err });
  } finally {
    client.release();
  }
}
