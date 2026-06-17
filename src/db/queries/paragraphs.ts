import { pool, DatabaseError } from '../index.js';
import { assertSpecWritable } from './edit-gate.js';
import type { Pool, PoolClient } from 'pg';
import { NodeTypeSchema } from '../../ast/index.js';
import type { NodeType, SignalConflict, SourceFacts, SpecNode, SpecTree } from '../../ast/index.js';

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

interface SubtreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
}

/** Validate a raw DB `node_type` string against the canonical AST enum before it
 *  crosses into a `SpecNode`. Guards against drift between the DB CHECK and the
 *  AST type without a cross-boundary assertion. */
function parseNodeType(nodeType: string): NodeType {
  const parsed = NodeTypeSchema.safeParse(nodeType);
  if (!parsed.success) {
    throw new DatabaseError(`buildSubtree: unexpected node_type "${nodeType}"`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Assemble subtree rows (a node plus all its descendants) into one SpecNode
 *  rooted at `rootId`. Mirrors buildNodeTree's meta shaping (specs.ts) but roots
 *  at a non-null parent rather than the forest roots. */
function buildSubtree(rows: readonly SubtreeRow[], rootId: string): SpecNode | null {
  const childrenByParent = new Map<string | null, SubtreeRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.parentId, [...(childrenByParent.get(row.parentId) ?? []), row]);
  }
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;

  const build = (row: SubtreeRow): SpecNode => ({
    id: row.id,
    type: parseNodeType(row.nodeType),
    text: row.text,
    children: (childrenByParent.get(row.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map(build),
    meta: {
      ...(row.vanish ? { vanish: true } : {}),
      ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
      ...(hasSourceFacts(row.sourceFacts) ? { sourceFacts: row.sourceFacts } : {}),
    },
  });

  return build(root);
}

/** Outcome of {@link updateParagraphText}: the spec/node pairing is validated
 *  before any write so the API can map `not-found` → 404 and `wrong-spec` → 403. */
export type UpdateParagraphResult =
  | { readonly status: 'updated'; readonly node: SpecNode }
  | { readonly status: 'not-found' }
  | { readonly status: 'wrong-spec' };

async function fetchSubtreeNode(
  db: Queryable,
  specId: string,
  nodeId: string
): Promise<SpecNode | null> {
  const result = await db.query<SubtreeRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id, parent_id, node_type, text, position, vanish, conflicts, source_facts
       FROM paragraphs WHERE id = $1 AND spec_id = $2
       UNION ALL
       SELECT p.id, p.parent_id, p.node_type, p.text, p.position, p.vanish,
              p.conflicts, p.source_facts
       FROM paragraphs p JOIN subtree s ON p.parent_id = s.id
       WHERE p.spec_id = $2
     )
     SELECT id, parent_id AS "parentId", node_type AS "nodeType", text, position,
            vanish, conflicts, source_facts AS "sourceFacts"
     FROM subtree`,
    [nodeId, specId]
  );
  return buildSubtree(result.rows, nodeId);
}

/**
 * Update a single paragraph's text by UUID, bumping `base_version` and
 * `updated_at` (ADR-009, #47). The (specId, nodeId) pair is verified under a row
 * lock before the write so a node that exists but belongs to another spec is
 * reported as `wrong-spec`, never silently edited.
 *
 * The write passes the composed edit gate first (ADR-018): the spec must be
 * writable (lifecycle + external state) and, when `expectedVersion` is given,
 * at that version — a stale value throws `StaleVersionError` rather than
 * clobbering a concurrent edit. A successful write bumps `specs.content_version`
 * so the next optimistic precondition sees the change.
 */
/** In-transaction body of {@link updateParagraphText}: gate → ownership check →
 *  write paragraph + bump specs.content_version. On a non-'updated' outcome the
 *  caller rolls back; on 'updated' the caller commits. */
async function applyParagraphUpdate(
  client: PoolClient,
  specId: string,
  nodeId: string,
  text: string,
  expectedVersion?: number
): Promise<UpdateParagraphResult> {
  // Gate first: row-locks the spec and validates lifecycle/external/version
  // before any paragraph write. Throws typed errors (forbidden / stale).
  await assertSpecWritable(client, specId, expectedVersion);

  const owner = await client.query<{ spec_id: string }>(
    `SELECT spec_id FROM paragraphs WHERE id = $1 FOR UPDATE`,
    [nodeId]
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow) return { status: 'not-found' };
  if (ownerRow.spec_id !== specId) return { status: 'wrong-spec' };

  await client.query(
    `UPDATE paragraphs SET text = $2, base_version = base_version + 1, updated_at = now()
     WHERE id = $1`,
    [nodeId, text]
  );
  await client.query(
    `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
    [specId]
  );

  const node = await fetchSubtreeNode(client, specId, nodeId);
  if (!node) throw new DatabaseError('updateParagraphText: updated node vanished mid-transaction');
  return { status: 'updated', node };
}

export async function updateParagraphText(
  specId: string,
  nodeId: string,
  text: string,
  expectedVersion?: number
): Promise<UpdateParagraphResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyParagraphUpdate(client, specId, nodeId, text, expectedVersion);
    await client.query(result.status === 'updated' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('updateParagraphText failed', { cause: err });
  } finally {
    client.release();
  }
}
