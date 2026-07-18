// Base-side structural snapshots of body-level objects (#520, ADR-072
// lineage) — the DB half of structural-conflict detection for the 3-way
// merge. Pairs with `theirs`' freshly-extracted `ExtractedObjectBlock`s
// (merge/extract.ts) by `objectId` so a table that gained/lost a row or
// column between base and theirs surfaces as a conflict, independent of any
// interior text edit.

import { pool, DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { ObjectMeta } from '../../ast/index.js';
import { parseObjectMeta } from './object-meta.js';
import { REMOVED_SUBTREE_CTE } from './versions.js';

interface Queryable {
  query: Pool['query'];
}

/**
 * Base-side structural snapshot of one body-level object: the parsed
 * `ObjectMeta` captured on its owning `object` row, plus the specr-uuid
 * anchors of its `objectText` interior children in document order.
 * `childUuids` is always an array — an unanchored/childless object (a text
 * box with no captured paragraphs, or one whose children were all
 * owner-removed) reports `[]`, never `null`/`undefined`.
 */
export interface ObjectStructuralSnapshot {
  readonly objectId: string;
  readonly meta: ObjectMeta;
  readonly childUuids: readonly string[];
}

interface ObjectStructureRow {
  readonly objectId: string;
  readonly objectData: unknown;
  readonly childUuids: readonly string[];
}

/**
 * Base-side structural snapshots for every `object` row in `specId` (#520).
 * Reuses {@link REMOVED_SUBTREE_CTE} (versions.ts) so an owner-removed
 * object — or one nested inside an owner-removed ancestor — is excluded
 * exactly like the paragraph snapshots it's paired with in diff.ts; the same
 * recursive CTE also excludes a removed object's `objectText` children, so
 * `childUuids` never anchors into content the renderers no longer emit.
 *
 * `object_data` is re-validated through {@link parseObjectMeta} on every
 * row — never trusted raw out of JSONB — matching the read discipline the
 * rest of the object-data surface (specs.ts, paragraphs.ts) already applies.
 * A row that fails that parse, or somehow carries no captured data despite
 * being `node_type = 'object'`, throws loud rather than silently dropping
 * out of the snapshot set.
 */
export async function getObjectStructuralSnapshots(
  specId: string,
  db: Queryable = pool
): Promise<ObjectStructuralSnapshot[]> {
  try {
    const result = await db.query<ObjectStructureRow>(
      `${REMOVED_SUBTREE_CTE}
       SELECT o.id AS "objectId",
              o.object_data AS "objectData",
              COALESCE(
                array_agg(c.id ORDER BY c.position) FILTER (WHERE c.id IS NOT NULL),
                '{}'
              ) AS "childUuids"
       FROM paragraphs o
       LEFT JOIN paragraphs c
         ON c.parent_id = o.id
        AND c.node_type = 'objectText'
        AND c.id NOT IN (SELECT id FROM removed_subtree)
       WHERE o.spec_id = $1
         AND o.node_type = 'object'
         AND o.id NOT IN (SELECT id FROM removed_subtree)
       GROUP BY o.id, o.object_data, o.position
       ORDER BY o.position, o.id`,
      [specId]
    );
    return result.rows.map(toSnapshot);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('getObjectStructuralSnapshots failed', { cause: err });
  }
}

function toSnapshot(row: ObjectStructureRow): ObjectStructuralSnapshot {
  const meta = parseObjectMeta('object', row.objectData, 'getObjectStructuralSnapshots');
  // parseObjectMeta only returns undefined for a non-'object' nodeType; the
  // query above already scoped to node_type = 'object', so this branch is
  // unreachable in practice (a real miss throws inside parseObjectMeta
  // itself) — kept only to satisfy the ObjectMeta | undefined return type.
  if (!meta) {
    throw new DatabaseError(
      `getObjectStructuralSnapshots: object row ${row.objectId} unexpectedly carries no captured object data`
    );
  }
  return { objectId: row.objectId, meta, childUuids: row.childUuids };
}
