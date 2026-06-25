// src/db/queries/versions.ts
import { pool, DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { ParagraphSnapshot } from '../../ast/types.js';

interface Queryable {
  query: Pool['query'];
}

// Owner-removed body paragraphs (#251: vanish=true, set via the /removal endpoint)
// are omitted from the generated DOCX, so both merge snapshots below exclude them
// — otherwise a removed node sits in base/ours but not in `theirs` (extracted from
// the regenerated DOCX) and is falsely reported as a hard deletion. Notes carry
// vanish=true too but ARE rendered (controlled in the DOCX), so they must stay in
// the snapshots — hence the `node_type = 'note'` guard, not a blanket vanish
// filter. See ADR-005 + the /removal endpoint (#276).

/**
 * Base-side snapshots for the 3-way merge (ADR-005). LEFT JOIN + COALESCE:
 * until merge writes snapshot rows (#36), paragraph_versions is empty and the
 * current paragraphs.text doubles as the base text (base_version defaults to 1).
 * Owner-removed body paragraphs are excluded (see the note above).
 */
export async function getParagraphSnapshots(
  specId: string,
  db: Queryable = pool
): Promise<ParagraphSnapshot[]> {
  try {
    const result = await db.query<ParagraphSnapshot>(
      `SELECT p.id AS "uuid",
              COALESCE(v.text, p.text) AS "text",
              p.base_version AS "baseVersion"
       FROM paragraphs p
       LEFT JOIN paragraph_versions v
         ON v.paragraph_id = p.id AND v.version = p.base_version
       WHERE p.spec_id = $1 AND (NOT p.vanish OR p.node_type = 'note')
       ORDER BY p.position, p.id`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getParagraphSnapshots failed', { cause: err });
  }
}

/** Current DB side for 3-way merge (`ours`), independent of base snapshots.
 *  Owner-removed body paragraphs are excluded (see the note above). */
export async function getCurrentParagraphSnapshots(
  specId: string,
  db: Queryable = pool
): Promise<ParagraphSnapshot[]> {
  try {
    const result = await db.query<ParagraphSnapshot>(
      `SELECT id AS "uuid", text, base_version AS "baseVersion"
       FROM paragraphs
       WHERE spec_id = $1 AND (NOT vanish OR node_type = 'note')
       ORDER BY position, id`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getCurrentParagraphSnapshots failed', { cause: err });
  }
}
