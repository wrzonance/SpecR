import { pool, DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { SignalConflict, SpecNode, SpecTree } from '../../ast/types.js';

interface Queryable {
  query: Pool['query'];
}
import { logger } from '../../lib/logger.js';

interface FlatRow {
  readonly id: string;
  readonly specId: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
}

function flattenDfs(
  nodes: readonly SpecNode[],
  specId: string,
  parentId: string | null,
  rows: FlatRow[]
): void {
  nodes.forEach((node, idx) => {
    rows.push({
      id: node.id,
      specId,
      parentId,
      nodeType: node.type,
      text: node.text,
      position: idx + 1,
      vanish: node.meta.vanish ?? false,
      conflicts: node.meta.conflicts ?? [],
    });
    flattenDfs(node.children, specId, node.id, rows);
  });
}

export async function insertTree(tree: SpecTree, specId: string, pool: Queryable): Promise<void> {
  const rows: FlatRow[] = [];
  flattenDfs(tree.parts, specId, null, rows);

  if (rows.length === 0) {
    logger.debug({ specId }, 'insertTree: no paragraphs to insert');
    return;
  }

  for (const row of rows) {
    try {
      await pool.query(
        `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, vanish, conflicts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          row.id,
          row.specId,
          row.parentId,
          row.nodeType,
          row.text,
          row.position,
          row.vanish,
          JSON.stringify(row.conflicts),
        ]
      );
    } catch (err) {
      throw new DatabaseError(`insertTree: failed to insert paragraph ${row.id}`, { cause: err });
    }
  }
  logger.info({ specId, count: rows.length }, 'insertTree: paragraphs inserted');
}

export interface ParagraphRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
  /** Inference signal disagreements (#56). Present only when non-empty. */
  readonly conflicts?: readonly SignalConflict[];
}

export interface ParagraphWithAncestors {
  readonly node: ParagraphRow;
  readonly ancestors: readonly ParagraphRow[];
}

interface ChainRow {
  readonly id: string;
  readonly nodeType: string;
  readonly text: string;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly depth: number;
}

function toParagraphRow(r: ChainRow): ParagraphRow {
  return {
    id: r.id,
    nodeType: r.nodeType,
    text: r.text,
    vanish: r.vanish,
    ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
  };
}

export async function getParagraphWithAncestors(
  id: string
): Promise<ParagraphWithAncestors | null> {
  try {
    const result = await pool.query<ChainRow>(
      `WITH RECURSIVE chain AS (
         SELECT id, node_type, text, vanish, conflicts, parent_id, 0 AS depth
         FROM paragraphs WHERE id = $1
         UNION ALL
         SELECT p.id, p.node_type, p.text, p.vanish, p.conflicts, p.parent_id, c.depth + 1
         FROM paragraphs p JOIN chain c ON p.id = c.parent_id
         WHERE c.depth + 1 < 10
       )
       SELECT id, node_type AS "nodeType", text, vanish, conflicts, depth
       FROM chain ORDER BY depth DESC`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const rows = result.rows;
    const node = rows[rows.length - 1]!;
    const ancestors = rows.slice(0, -1);
    return {
      node: toParagraphRow(node),
      ancestors: ancestors.map(toParagraphRow),
    };
  } catch (err) {
    throw new DatabaseError('getParagraphWithAncestors failed', { cause: err });
  }
}

// Deletes one paragraph (scoped to its spec for safety). Per the schema, this
// CASCADES to the paragraph's child paragraphs, its spec_references
// (source_paragraph_id), its paragraph_versions, and its revit mappings — so
// "delete the paragraph that contains a citation" removes the citation too,
// deterministically, in a single statement. Returns false if nothing matched.
export async function deleteParagraph(id: string, specId: string): Promise<boolean> {
  try {
    const result = await pool.query<{ id: string }>(
      `DELETE FROM paragraphs WHERE id = $1 AND spec_id = $2 RETURNING id`,
      [id, specId]
    );
    return result.rows.length > 0;
  } catch (err) {
    throw new DatabaseError(`deleteParagraph: failed for ${id}`, { cause: err });
  }
}

export interface UpdatedParagraph {
  readonly id: string;
  readonly text: string;
}

// Replaces a paragraph's body text in place (scoped to its spec). Does not
// touch references — the caller decides what happens to citations the edit
// removed. Returns null if no paragraph matched.
export async function updateParagraphText(
  id: string,
  specId: string,
  text: string
): Promise<UpdatedParagraph | null> {
  try {
    const result = await pool.query<UpdatedParagraph>(
      `UPDATE paragraphs SET text = $3, updated_at = now()
       WHERE id = $1 AND spec_id = $2
       RETURNING id, text`,
      [id, specId, text]
    );
    const row = result.rows[0];
    return row ? { id: row.id, text: row.text } : null;
  } catch (err) {
    throw new DatabaseError(`updateParagraphText: failed for ${id}`, { cause: err });
  }
}
