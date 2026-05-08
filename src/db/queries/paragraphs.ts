import { DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { CsiNode, CsiTree } from '../../ast/types.js';
import { logger } from '../../lib/logger.js';

interface FlatRow {
  readonly id: string;
  readonly specId: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
}

function flattenDfs(
  nodes: readonly CsiNode[],
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
      position: idx,
      vanish: node.meta.vanish ?? false,
    });
    flattenDfs(node.children, specId, node.id, rows);
  });
}

export async function insertTree(tree: CsiTree, specId: string, pool: Pool): Promise<void> {
  const rows: FlatRow[] = [];
  flattenDfs(tree.parts, specId, null, rows);

  if (rows.length === 0) {
    logger.debug({ specId }, 'insertTree: no paragraphs to insert');
    return;
  }

  try {
    for (const row of rows) {
      await pool.query(
        `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, vanish)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, row.specId, row.parentId, row.nodeType, row.text, row.position, row.vanish]
      );
    }
    logger.info({ specId, count: rows.length }, 'insertTree: paragraphs inserted');
  } catch (err) {
    throw new DatabaseError('failed to insert paragraph tree', { cause: err });
  }
}
