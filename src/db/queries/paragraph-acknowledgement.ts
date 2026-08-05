import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import { bumpSpecContentVersion } from './content-version.js';
import { recordParagraphHistory, resolveHistoryContext } from './paragraph-history.js';
import { parseObjectMeta } from './object-meta.js';
import { NodeTypeSchema } from '../../ast/index.js';
import type { PoolClient } from 'pg';
import type { SpecNode } from '../../ast/index.js';
import { fetchSubtreeNode } from './paragraphs.js';

// #545, ADR-079 follow-on: per-node acknowledgement, closing the readiness
// gate's "no supported API path to clear specifier_note_present /
// body_object_present" gap. Deliberately SEPARATE state from `vanish` and
// its REMOVABLE_NODE_TYPES set (paragraph-vanish.ts) — the comment above
// that set explains that the owner-facing renderers emit `note` blockquotes
// and consider `object` nodes before ever checking vanish, so storing vanish
// on those types would silently lie about the removal contract.
// Acknowledgement never hides content: it only affirms a human has read and
// accepted it, and readiness-review.ts is the ONLY consumer — no renderer
// may ever branch on `meta.acknowledged`.

/** Which node "shapes" can be acknowledged, mirroring exactly the two
 *  readiness findings acknowledgement exists to clear: a `note` node
 *  (specifier_note_present), or an `object` node whose captured content is a
 *  `textBox` (body_object_present — tables are structural content, ADR-072,
 *  and are never acknowledgeable). Reuses `parseObjectMeta`'s existing
 *  textBox derivation rather than re-deriving it from raw JSONB. */
function isAcknowledgeableRow(nodeType: string, objectData: unknown): boolean {
  if (nodeType === 'note') return true;
  const parsedType = NodeTypeSchema.safeParse(nodeType);
  if (!parsedType.success) return false;
  const objectMeta = parseObjectMeta(parsedType.data, objectData, 'isAcknowledgeableRow');
  return objectMeta?.kind === 'textBox';
}

/** Outcome of {@link setParagraphAcknowledged}: the (specId, nodeId) pairing
 *  is validated before the write so the API maps `not-found` → 404,
 *  `wrong-spec` → 403, and `not-acknowledgeable` → 422 for a node type that
 *  cannot produce either of the two findings acknowledgement clears. */
export type SetAcknowledgedResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'not-acknowledgeable'; readonly nodeType: string };

/** Outcome of {@link setAcknowledgedRow}. Widens the public
 *  {@link SetAcknowledgedResult}'s `updated` branch with the pre-toggle image
 *  the caller needs to snapshot a `paragraph_versions` row without a second
 *  `FOR UPDATE` round-trip. {@link applyAcknowledged} strips these extra
 *  fields before returning the public shape. */
export type SetAcknowledgedRowResult =
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
  | { readonly status: 'not-acknowledgeable'; readonly nodeType: string };

/**
 * The reusable DB core behind {@link setParagraphAcknowledged}: lock the
 * row, validate ownership and acknowledgeability, and toggle `acknowledged`
 * — a no-op when it already matches the requested value.
 *
 * Deliberately gate-free and bump-free: it never calls `assertSpecWritable`
 * and never touches `specs.content_version` — the caller owns both, mirroring
 * `setVanishRow`'s (paragraph-vanish.ts) exact same split.
 *
 * LOCK ORDER (invariant shared with updateParagraphText, setVanishRow, and
 * acceptCommentAsNote): the spec row must already be gated/locked by the
 * caller BEFORE this runs.
 */
export async function setAcknowledgedRow(
  client: PoolClient,
  specId: string,
  nodeId: string,
  acknowledged: boolean
): Promise<SetAcknowledgedRowResult> {
  const owner = await client.query<{
    spec_id: string;
    node_type: string;
    acknowledged: boolean;
    text: string;
    base_version: number;
    object_data: unknown;
  }>(
    `SELECT spec_id, node_type, acknowledged, text, base_version, object_data
     FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) return { status: 'not-found' };
  // UUIDs compare case-insensitively in PostgreSQL but `pg` returns spec_id
  // lowercased, while z.uuid() accepts (and preserves) an uppercase input —
  // normalize both sides before comparing (mirrors setVanishRow).
  if (ownerRow.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };
  if (!isAcknowledgeableRow(ownerRow.node_type, ownerRow.object_data)) {
    return { status: 'not-acknowledgeable', nodeType: ownerRow.node_type };
  }

  // Idempotent toggle: a no-op (already at the requested value) must NOT
  // write — a retried apply must not mint phantom base_version bumps.
  const changed = ownerRow.acknowledged !== acknowledged;
  if (changed) {
    await client.query(
      `UPDATE paragraphs SET acknowledged = $2, base_version = base_version + 1, updated_at = now()
       WHERE id = $1`,
      [nodeId, acknowledged]
    );
  }

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('setAcknowledgedRow: updated node vanished mid-transaction');
  return {
    status: 'updated',
    node,
    changed,
    previousText: ownerRow.text,
    previousNodeType: ownerRow.node_type,
    previousBaseVersion: ownerRow.base_version,
  };
}

/** In-transaction body of {@link setParagraphAcknowledged}: gate → delegate
 *  the toggle to {@link setAcknowledgedRow} → snapshot the pre-toggle image
 *  under op `'acknowledge'`/`'unacknowledge'` → bump `content_version` once,
 *  only on an effective ('changed') write. Mirrors `applyVanish`
 *  (paragraph-vanish.ts) structurally. */
async function applyAcknowledged(
  client: PoolClient,
  specId: string,
  nodeId: string,
  acknowledged: boolean,
  actorLabel?: string
): Promise<SetAcknowledgedResult> {
  const gate = await assertSpecWritable(client, specId);

  const result = await setAcknowledgedRow(client, specId, nodeId, acknowledged);
  if (result.status !== 'updated') return result;

  if (result.changed) {
    const historyContext = await resolveHistoryContext(client, gate.contentVersion, actorLabel);
    await recordParagraphHistory(client, {
      paragraphId: nodeId,
      specId,
      // The snapshot records the paragraph's PRE-toggle image: acknowledgement
      // changes no text, only readiness-review visibility, so the pre-toggle
      // text/node_type IS the state this row must describe (mirrors
      // applyVanish's identical reasoning).
      version: result.previousBaseVersion + 1,
      text: result.previousText,
      nodeType: result.previousNodeType,
      op: acknowledged ? 'acknowledge' : 'unacknowledge',
      contentVersion: historyContext.contentVersion,
      userId: historyContext.userId,
      payload: null,
    });
    await bumpSpecContentVersion(client, specId);
  }

  return { status: 'updated', node: result.node };
}

/**
 * Set or clear a paragraph's `acknowledged` flag by UUID (#545, ADR-079
 * follow-on): the specifier affirms they have read and accepted a `note` or
 * a `textBox` `object` node, clearing the readiness gate's
 * `specifier_note_present` / `body_object_present` finding for it WITHOUT
 * removing or hiding the content — the content still renders exactly as
 * before. Only `note` nodes and `textBox`-kind `object` nodes are
 * acknowledgeable; every other node type (including a `table`-kind object,
 * ADR-072) is rejected `not-acknowledgeable`. Passes the composed edit gate
 * (ADR-018) and verifies the (specId, nodeId) pairing under a row lock. The
 * toggle is idempotent — a no-op leaves the row untouched; an effective
 * change bumps `specs.content_version` and snapshots a `paragraph_versions`
 * row under op `'acknowledge'`/`'unacknowledge'`, attributed to `actorLabel`
 * (falls back to the SYSTEM_ACTOR_LABEL sentinel when omitted).
 */
export async function setParagraphAcknowledged(
  specId: string,
  nodeId: string,
  acknowledged: boolean,
  actorLabel?: string
): Promise<SetAcknowledgedResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyAcknowledged(client, specId, nodeId, acknowledged, actorLabel);
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setParagraphAcknowledged failed', { cause: err });
  } finally {
    client.release();
  }
}
