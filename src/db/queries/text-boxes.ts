import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { SpecNotFoundError } from './edit-gate.js';
import { ProjectNotFoundError } from './derive.js';
import { parseObjectMeta } from './object-meta.js';
import { REMOVED_SUBTREE_CTE } from './versions.js';
import type { ObjectGeneration } from '../../ast/index.js';

export type TextBoxScope =
  | { readonly kind: 'spec'; readonly specId: string }
  | { readonly kind: 'project'; readonly projectId: string };

export interface TextBoxReportItem {
  readonly specId: string;
  readonly specSection: string;
  readonly paragraphId: string;
  readonly floating: boolean;
  readonly generation: ObjectGeneration;
  readonly interiorText: readonly string[];
}

export interface TextBoxReport {
  readonly scope: TextBoxScope;
  readonly textBoxes: readonly TextBoxReportItem[];
  readonly summary: { readonly textBoxes: number };
}

interface TextBoxRow {
  readonly specId: string;
  readonly specSection: string;
  readonly paragraphId: string;
  readonly objectData: unknown;
  readonly interiorText: readonly string[];
}

interface Queryable {
  query: Pool['query'];
}

const SPEC_SQL = `${REMOVED_SUBTREE_CTE}
  SELECT o.id AS "paragraphId", s.id AS "specId", s.section AS "specSection",
         o.object_data AS "objectData",
         COALESCE(
           array_agg(t.text ORDER BY t.position, t.id) FILTER (WHERE t.id IS NOT NULL),
           ARRAY[]::text[]
         ) AS "interiorText"
    FROM paragraphs o
    JOIN specs s ON s.id = o.spec_id
    LEFT JOIN paragraphs t
      ON t.parent_id = o.id
     AND t.node_type = 'objectText'
     AND t.id NOT IN (SELECT id FROM removed_subtree)
   WHERE o.spec_id = $1
     AND o.node_type = 'object'
     AND o.object_data->>'kind' = 'textBox'
     AND o.id NOT IN (SELECT id FROM removed_subtree)
   GROUP BY o.id, s.id, s.section, o.position, o.object_data
   ORDER BY o.position, o.id`;

const PROJECT_REMOVED_SUBTREE_CTE = `WITH RECURSIVE removed_subtree AS (
  SELECT p.id FROM paragraphs p
   WHERE p.spec_id IN (SELECT spec_id FROM project_specs WHERE project_id = $1)
     AND p.vanish = true
     AND p.node_type <> 'note'
  UNION ALL
  SELECT c.id FROM paragraphs c
    JOIN removed_subtree r ON c.parent_id = r.id
)`;

const PROJECT_SQL = `${PROJECT_REMOVED_SUBTREE_CTE}
  SELECT o.id AS "paragraphId", s.id AS "specId", s.section AS "specSection",
         o.object_data AS "objectData",
         COALESCE(
           array_agg(t.text ORDER BY t.position, t.id) FILTER (WHERE t.id IS NOT NULL),
           ARRAY[]::text[]
         ) AS "interiorText"
    FROM project_specs ps
    JOIN specs s ON s.id = ps.spec_id
    JOIN paragraphs o ON o.spec_id = s.id
    LEFT JOIN paragraphs t
      ON t.parent_id = o.id
     AND t.node_type = 'objectText'
     AND t.id NOT IN (SELECT id FROM removed_subtree)
   WHERE ps.project_id = $1
     AND o.node_type = 'object'
     AND o.object_data->>'kind' = 'textBox'
     AND o.id NOT IN (SELECT id FROM removed_subtree)
   GROUP BY o.id, s.id, s.section, o.position, o.object_data
   ORDER BY s.section, o.position, o.id`;

async function assertScope(scope: TextBoxScope, client: Queryable): Promise<void> {
  const id = scope.kind === 'spec' ? scope.specId : scope.projectId;
  const table = scope.kind === 'spec' ? 'specs' : 'projects';
  const result = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if ((result.rowCount ?? 0) > 0) return;
  if (scope.kind === 'spec') throw new SpecNotFoundError(`spec ${id} not found`);
  throw new ProjectNotFoundError(`project ${id} not found`);
}

function toTextBox(row: TextBoxRow): TextBoxReportItem {
  const objectMeta = parseObjectMeta('object', row.objectData, 'getTextBoxesReport');
  if (!objectMeta || objectMeta.kind !== 'textBox') {
    throw new DatabaseError(`getTextBoxesReport: row ${row.paragraphId} is not a text box`);
  }
  return {
    specId: row.specId,
    specSection: row.specSection,
    paragraphId: row.paragraphId,
    floating: objectMeta.floating,
    generation: objectMeta.generation,
    interiorText: row.interiorText,
  };
}

async function readRows(scope: TextBoxScope, client: Queryable): Promise<readonly TextBoxRow[]> {
  const sql = scope.kind === 'spec' ? SPEC_SQL : PROJECT_SQL;
  const id = scope.kind === 'spec' ? scope.specId : scope.projectId;
  const result = await client.query<TextBoxRow>(sql, [id]);
  return result.rows;
}

function buildReport(scope: TextBoxScope, rows: readonly TextBoxRow[]): TextBoxReport {
  const textBoxes = rows.map(toTextBox);
  return { scope, textBoxes, summary: { textBoxes: textBoxes.length } };
}

/** Report retained body-level text boxes for one spec or every spec in a project.
 * Tables are excluded by the persisted ObjectMeta kind, while owner-removed
 * subtrees follow the same suppression CTE used by merge snapshots. */
export async function getTextBoxesReport(
  scope: TextBoxScope,
  db: Pool = pool
): Promise<TextBoxReport> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertScope(scope, client);
    const rows = await readRows(scope, client);
    await client.query('COMMIT');
    return buildReport(scope, rows);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) throw err;
    throw new DatabaseError('getTextBoxesReport failed', { cause: err });
  } finally {
    if (client) client.release();
  }
}
