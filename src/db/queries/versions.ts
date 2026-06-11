// src/db/queries/versions.ts
import { pool, DatabaseError } from '../index.js';
import type { ParagraphSnapshot } from '../../ast/types.js';

/**
 * Base-side snapshots for the 3-way merge (ADR-005). LEFT JOIN + COALESCE:
 * until merge writes snapshot rows (#36), paragraph_versions is empty and the
 * current paragraphs.text doubles as the base text (base_version defaults to 1).
 */
export async function getParagraphSnapshots(specId: string): Promise<ParagraphSnapshot[]> {
  try {
    const result = await pool.query<ParagraphSnapshot>(
      `SELECT p.id AS "uuid",
              COALESCE(v.text, p.text) AS "text",
              p.base_version AS "baseVersion"
       FROM paragraphs p
       LEFT JOIN paragraph_versions v
         ON v.paragraph_id = p.id AND v.version = p.base_version
       WHERE p.spec_id = $1
       ORDER BY p.position, p.id`,
      [specId]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getParagraphSnapshots failed', { cause: err });
  }
}
