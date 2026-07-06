import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import type { PoolClient } from 'pg';
import type { InsertableNodeType, SpecNode } from '../../ast/index.js';
import { InsertableNodeTypeSchema } from '../../ast/index.js';
import { fetchSubtreeNode } from './paragraphs.js';

// Sibling paragraph insertion (#372): the DB primitive behind the WYSIWYG
// Enter gesture, and the one the merge engine's added-op apply (#374) will
// reuse. Inserts a new node immediately after an anchor, under the anchor's
// parent, shifting the following siblings' positions — the same mechanic as
// the accept-comment-as-note materialization (reclassify.ts), generalized to
// caller-chosen body/heading types.

/** Outcome of {@link insertParagraphAfter}. `invalid-type` carries the type
 *  that was refused — an explicit request outside the insertable set
 *  (schema-blocked at the API, but the DB revalidates), a defaulted non-
 *  insertable anchor type (part/note), or a root (PART) anchor, which has no
 *  insertable sibling regardless of an explicit override. */
export type InsertParagraphResult =
  | { readonly status: 'created'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'invalid-type'; readonly nodeType: string };

export interface InsertParagraphInput {
  readonly anchorNodeId: string;
  readonly text: string;
  readonly nodeType?: InsertableNodeType;
  readonly expectedVersion?: number;
}

interface AnchorRow {
  readonly spec_id: string;
  readonly parent_id: string | null;
  readonly position: number;
  readonly node_type: string;
}

/** In-transaction body. LOCK ORDER (invariant shared with updateParagraphText
 *  and acceptCommentAsNote): the spec row is gated/locked BEFORE the anchor
 *  paragraph `FOR UPDATE` — inverting it would let concurrent paragraph write
 *  paths deadlock holding one lock each. */
async function runInsert(
  client: PoolClient,
  specId: string,
  input: InsertParagraphInput
): Promise<InsertParagraphResult> {
  await assertSpecWritable(client, specId, input.expectedVersion);

  const anchorRes = await client.query<AnchorRow>(
    `SELECT spec_id, parent_id, position, node_type FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [input.anchorNodeId]
  );
  const anchor = anchorRes.rows[0];
  if (!anchor) return { status: 'not-found' };
  // UUIDs compare case-insensitively in PostgreSQL but `pg` returns spec_id
  // lowercased, while z.uuid() accepts (and preserves) an uppercase input —
  // normalize both sides, else an uppercase specId false-403s.
  if (anchor.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };

  const nodeType = input.nodeType ?? anchor.node_type;
  // A PART has no insertable sibling — the only valid sibling of a part is
  // another part, which is deliberately non-insertable. Guard the anchor type
  // too, else an explicit nodeType (e.g. 'article') slips past the insertable
  // check and lands a non-part node beside the part at parent_id = NULL, which
  // the renderers then mislabel as a PART and round-trip breaks.
  const insertable =
    anchor.node_type !== 'part' && InsertableNodeTypeSchema.safeParse(nodeType).success;
  if (!insertable) {
    return { status: 'invalid-type', nodeType };
  }

  await client.query(
    `UPDATE paragraphs SET position = position + 1
     WHERE spec_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND position > $3`,
    [anchor.spec_id, anchor.parent_id, anchor.position]
  );
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [anchor.spec_id, anchor.parent_id, nodeType, input.text, anchor.position + 1]
  );
  const row = inserted.rows[0];
  if (!row) throw new DatabaseError('insertParagraphAfter: insert returned no row');

  // A new node is a content write — bump content_version so the next
  // optimistic precondition (and project-copy drift detection) sees it,
  // mirroring updateParagraphText / insertNoteSibling.
  await client.query(
    `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
    [anchor.spec_id]
  );

  const node = await fetchSubtreeNode(client, anchor.spec_id, row.id);
  if (!node)
    throw new DatabaseError('insertParagraphAfter: inserted node vanished mid-transaction');
  return { status: 'created', node };
}

/**
 * Insert a new paragraph immediately after `input.anchorNodeId`, as its
 * sibling (same parent), shifting later siblings down one position (#372).
 * The node type defaults to the anchor's own; only body paragraphs, articles,
 * and continuations are insertable — a part or note default is refused.
 *
 * Passes the composed edit gate first (ADR-018): the spec must be writable
 * and, when `expectedVersion` is given, at that version — a stale value
 * throws `StaleVersionError`. Returns the created node as a SpecNode.
 */
export async function insertParagraphAfter(
  specId: string,
  input: InsertParagraphInput
): Promise<InsertParagraphResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await runInsert(client, specId, input);
    await client.query(result.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('insertParagraphAfter failed', { cause: err });
  } finally {
    client.release();
  }
}
