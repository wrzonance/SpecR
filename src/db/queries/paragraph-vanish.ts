import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import type { PoolClient } from 'pg';
import type { SpecNode } from '../../ast/index.js';
import { fetchSubtreeNode } from './paragraphs.js';

// Reversible paragraph removal (#251, ADR-022), extracted from paragraphs.ts
// (#374) so the merge engine's deleted-op apply can reuse the same gate-free
// DB core the standalone PATCH .../removal endpoint already uses — the same
// split already applied to sibling insertion (paragraph-insert.ts, #372).

// Node types the owner-facing renderers (DOCX, Markdown) actually suppress when
// `vanish` is set. Both emit `note` blockquotes *before* checking vanish, and the
// markdown part/article heading renderers never check vanish at all — so storing
// vanish on those types would silently lie about the removal contract. Removal
// only applies to body paragraphs.
const REMOVABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  'pr1',
  'pr2',
  'pr3',
  'pr4',
  'pr5',
  'pr6',
  'pr7',
  'continuation',
]);

/** Outcome of {@link setParagraphVanish}: the (specId, nodeId) pairing is
 *  validated before the write so the API maps `not-found` → 404 and
 *  `wrong-spec` → 403 (mirrors updateParagraphText); `not-removable` → 422 for a
 *  structural/note node the renderers cannot hide. */
export type SetVanishResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' }
  | { readonly status: 'not-removable'; readonly nodeType: string };

/** Outcome of {@link setVanishRow}. Widens the public {@link SetVanishResult}'s
 *  `updated` branch with the pre-toggle image (`previousText`/`previousNodeType`/
 *  `previousBaseVersion`) plus `changed` — the merge engine's deleted-op apply
 *  (#374) needs those to build a `paragraph_versions` snapshot row and must not
 *  re-fetch them with a second `FOR UPDATE` round-trip (that would double-lock
 *  the same row within one transaction). {@link setParagraphVanish} strips these
 *  extra fields before returning the public shape. */
export type SetVanishRowResult =
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
  | { readonly status: 'not-removable'; readonly nodeType: string };

/**
 * The reusable DB core behind {@link setParagraphVanish} and (once wired,
 * #374) the merge engine's deleted-op apply: lock the row, validate ownership
 * and removability, and toggle `vanish` — a no-op when it already matches the
 * requested value.
 *
 * Deliberately gate-free and bump-free: it never calls `assertSpecWritable`
 * and never touches `specs.content_version` — the caller owns both, exactly
 * once per outer write, not once per paragraph toggled (a merge apply of N
 * deleted-ops must bump the version once, not N times).
 *
 * LOCK ORDER (invariant shared with updateParagraphText, insertSiblingRow, and
 * acceptCommentAsNote): the spec row must already be gated/locked by the
 * caller BEFORE this runs — inverting it would let concurrent paragraph write
 * paths deadlock holding one lock each.
 */
export async function setVanishRow(
  client: PoolClient,
  specId: string,
  nodeId: string,
  vanish: boolean
): Promise<SetVanishRowResult> {
  const owner = await client.query<{
    spec_id: string;
    node_type: string;
    vanish: boolean;
    text: string;
    base_version: number;
  }>(
    `SELECT spec_id, node_type, vanish, text, base_version FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) return { status: 'not-found' };
  // UUIDs compare case-insensitively in PostgreSQL but `pg` returns spec_id
  // lowercased, while z.uuid() accepts (and preserves) an uppercase input — so
  // normalize both sides before comparing, else an uppercase specId false-403s.
  if (ownerRow.spec_id.toLowerCase() !== specId.toLowerCase()) return { status: 'wrong-spec' };
  if (!REMOVABLE_NODE_TYPES.has(ownerRow.node_type)) {
    return { status: 'not-removable', nodeType: ownerRow.node_type };
  }

  // Idempotent toggle: a no-op (vanish already at the requested value) must NOT
  // write — a retried/duplicate apply would otherwise mint phantom base_version
  // bumps and make concurrent optimistic writes fail stale.
  const changed = ownerRow.vanish !== vanish;
  if (changed) {
    await client.query(
      `UPDATE paragraphs SET vanish = $2, base_version = base_version + 1, updated_at = now()
       WHERE id = $1`,
      [nodeId, vanish]
    );
  }

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('setVanishRow: updated node vanished mid-transaction');
  return {
    status: 'updated',
    node,
    changed,
    previousText: ownerRow.text,
    previousNodeType: ownerRow.node_type,
    previousBaseVersion: ownerRow.base_version,
  };
}

/** In-transaction body of {@link setParagraphVanish}: gate → delegate the
 *  toggle to {@link setVanishRow} → bump `content_version` once, only on an
 *  effective ('changed') write, then strip the extra pre-image fields before
 *  returning the public {@link SetVanishResult} shape. */
async function applyVanish(
  client: PoolClient,
  specId: string,
  nodeId: string,
  vanish: boolean
): Promise<SetVanishResult> {
  // Gate first: row-locks the spec and validates lifecycle/external state
  // before any paragraph write. Throws typed errors (forbidden).
  await assertSpecWritable(client, specId);

  const result = await setVanishRow(client, specId, nodeId, vanish);
  if (result.status !== 'updated') return result;

  if (result.changed) {
    await client.query(
      `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
      [specId]
    );
  }

  return { status: 'updated', node: result.node };
}

/**
 * Set or clear a paragraph's `vanish` flag by UUID — the editability program's
 * reversible removal (#251, ADR-022). `vanish: true` suppresses the node from
 * the owner-facing renders (DOCX, Markdown) while keeping the row, its subtree,
 * and contained refs intact; `false` reverses it. Only body paragraphs are
 * removable: structural headings (`part`/`article`) and `note` nodes are rejected
 * `not-removable` because the owner-facing renderers cannot suppress them, so
 * vanish on those would silently lie. Passes the composed edit gate (ADR-018) and
 * verifies the (specId, nodeId) pairing under a row lock, so removal is
 * authorized exactly like any other content write. The toggle is idempotent — a
 * no-op (vanish already at the requested value) leaves the row untouched; an
 * effective change bumps `specs.content_version`.
 */
export async function setParagraphVanish(
  specId: string,
  nodeId: string,
  vanish: boolean
): Promise<SetVanishResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyVanish(client, specId, nodeId, vanish);
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('setParagraphVanish failed', { cause: err });
  } finally {
    client.release();
  }
}
