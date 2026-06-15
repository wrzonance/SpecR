import { pool, DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { SignalConflict, SourceFacts, SpecNode, SpecTree } from '../../ast/index.js';

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
  readonly sourceFacts: SourceFacts;
}

function hasSourceFacts(sourceFacts: SourceFacts): boolean {
  return Object.keys(sourceFacts).length > 0;
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
      sourceFacts: node.meta.sourceFacts ?? {},
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
        `INSERT INTO paragraphs
           (id, spec_id, parent_id, node_type, text, position, vanish, conflicts, source_facts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
        [
          row.id,
          row.specId,
          row.parentId,
          row.nodeType,
          row.text,
          row.position,
          row.vanish,
          JSON.stringify(row.conflicts),
          JSON.stringify(row.sourceFacts),
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
  /** Parser source facts (#131). Present only when non-empty. */
  readonly sourceFacts?: SourceFacts;
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
  readonly sourceFacts: SourceFacts;
  readonly depth: number;
}

function toParagraphRow(r: ChainRow): ParagraphRow {
  return {
    id: r.id,
    nodeType: r.nodeType,
    text: r.text,
    vanish: r.vanish,
    ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
    ...(hasSourceFacts(r.sourceFacts) ? { sourceFacts: r.sourceFacts } : {}),
  };
}

export async function getParagraphWithAncestors(
  id: string
): Promise<ParagraphWithAncestors | null> {
  try {
    const result = await pool.query<ChainRow>(
      `WITH RECURSIVE chain AS (
         SELECT id, node_type, text, vanish, conflicts, source_facts, parent_id, 0 AS depth
         FROM paragraphs WHERE id = $1
         UNION ALL
         SELECT p.id, p.node_type, p.text, p.vanish, p.conflicts, p.source_facts,
                p.parent_id, c.depth + 1
         FROM paragraphs p JOIN chain c ON p.id = c.parent_id
         WHERE c.depth + 1 < 10
       )
       SELECT id, node_type AS "nodeType", text, vanish, conflicts,
              source_facts AS "sourceFacts", depth
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
