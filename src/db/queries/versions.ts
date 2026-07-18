// src/db/queries/versions.ts
import { pool, DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { ParagraphSnapshot } from '../../ast/types.js';

interface Queryable {
  query: Pool['query'];
}

// Owner-removed paragraphs (#251: vanish=true, set via the /removal endpoint) are
// omitted from the generated DOCX/Markdown — and because both renderers skip the
// ENTIRE subtree of a vanished node (DOCX emitNode returns false → no child
// recursion; markdown renderPrNode returns '' before rendering children), a
// removed node AND all its descendants disappear from `theirs`. So both merge
// snapshots must exclude the removed node and its whole subtree — otherwise those
// rows sit in base/ours but not in `theirs` (extracted from the regenerated DOCX)
// and are falsely reported as hard deletions. Notes carry vanish=true too but ARE
// rendered (content-controlled in the DOCX), so they are not removal roots — hence
// the `node_type <> 'note'` guard, not a blanket vanish filter. See ADR-005 + the
// /removal endpoint (#276).
//
// `removed_subtree` = vanished non-note roots ∪ their descendants (recursive over
// parent_id). $1 = specId. Prepend to a snapshot query and exclude its ids.
// Exported for reuse by object-structure.ts's base-side structural snapshots
// (#520) — an owner-removed `object` row (or its `objectText` children) must
// drop from those snapshots for exactly the same reason paragraph snapshots
// do: the renderers skip the whole vanished subtree.
export const REMOVED_SUBTREE_CTE = `
  WITH RECURSIVE removed_subtree AS (
    SELECT id FROM paragraphs
     WHERE spec_id = $1 AND vanish = true AND node_type <> 'note'
    UNION ALL
    SELECT c.id FROM paragraphs c
      JOIN removed_subtree r ON c.parent_id = r.id
  )`;

/**
 * Base-side snapshots for the 3-way merge (ADR-005). LEFT JOIN + COALESCE:
 * until merge writes snapshot rows (#36), paragraph_versions is empty and the
 * current paragraphs.text doubles as the base text (base_version defaults to 1).
 * Owner-removed subtrees are excluded (see {@link REMOVED_SUBTREE_CTE}).
 */
export async function getParagraphSnapshots(
  specId: string,
  db: Queryable = pool
): Promise<ParagraphSnapshot[]> {
  try {
    const result = await db.query<ParagraphSnapshot>(
      `${REMOVED_SUBTREE_CTE}
       SELECT p.id AS "uuid",
              COALESCE(v.text, p.text) AS "text",
              p.base_version AS "baseVersion"
       FROM paragraphs p
       LEFT JOIN paragraph_versions v
         ON v.paragraph_id = p.id AND v.version = p.base_version
       WHERE p.spec_id = $1 AND p.id NOT IN (SELECT id FROM removed_subtree)
       ORDER BY p.position, p.id`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getParagraphSnapshots failed', { cause: err });
  }
}

/** Current DB side for 3-way merge (`ours`), independent of base snapshots.
 *  Owner-removed subtrees are excluded (see {@link REMOVED_SUBTREE_CTE}). */
export async function getCurrentParagraphSnapshots(
  specId: string,
  db: Queryable = pool
): Promise<ParagraphSnapshot[]> {
  try {
    const result = await db.query<ParagraphSnapshot>(
      `${REMOVED_SUBTREE_CTE}
       SELECT id AS "uuid", text, base_version AS "baseVersion"
       FROM paragraphs
       WHERE spec_id = $1 AND id NOT IN (SELECT id FROM removed_subtree)
       ORDER BY position, id`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getCurrentParagraphSnapshots failed', { cause: err });
  }
}
