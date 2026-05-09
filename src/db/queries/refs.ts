import { DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { SecRef } from '../../ast/types.js';

interface Queryable {
  query: Pool['query'];
}
import { logger } from '../../lib/logger.js';

export async function insertRefs(
  refs: readonly SecRef[],
  specId: string,
  pool: Queryable
): Promise<void> {
  if (refs.length === 0) {
    return;
  }

  for (const ref of refs) {
    try {
      let targetSpecId: string | null = null;

      if (ref.targetType === 'section' && ref.targetSpecSection) {
        const result = await pool.query<{ id: string }>(
          'SELECT id FROM specs WHERE section = $1 LIMIT 1',
          [ref.targetSpecSection]
        );
        targetSpecId = result.rows[0]?.id ?? null;
      }

      await pool.query(
        `INSERT INTO spec_references
           (source_spec_id, source_paragraph_id, target_type,
            target_spec_section, target_spec_id, standard_code, reference_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          specId,
          ref.sourceNodeId,
          ref.targetType,
          ref.targetSpecSection ?? null,
          targetSpecId,
          ref.standardCode ?? null,
          ref.referenceText,
        ]
      );
    } catch (err) {
      throw new DatabaseError(`insertRefs: failed on ref ${ref.sourceNodeId} (${ref.targetType})`, {
        cause: err,
      });
    }
  }

  logger.info({ specId, count: refs.length }, 'insertRefs: references inserted');
}
