import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';
import {
  buildReferenceGraph,
  type GraphNodeInput,
  type GraphRefRowInput,
  type ReferenceGraph,
} from './reference-graph.js';

export type GraphScope =
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'library'; readonly id: string };

interface NodeRow {
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
}
interface RefRow {
  readonly source_spec_id: string;
  readonly target_spec_section: string;
  readonly source_paragraph_id: string;
}

async function assertScopeExists(scope: GraphScope, client: PoolClient): Promise<void> {
  if (scope.kind === 'project') {
    const r = await client.query('SELECT 1 FROM projects WHERE id = $1', [scope.id]);
    if ((r.rowCount ?? 0) === 0) throw new ProjectNotFoundError(`project ${scope.id} not found`);
    return;
  }
  const r = await client.query('SELECT 1 FROM libraries WHERE id = $1', [scope.id]);
  if ((r.rowCount ?? 0) === 0) throw new LibraryNotFoundError(`library ${scope.id} not found`);
}

// Withdrawn masters (ADR-030) never appear as nodes — matching coordination's present set.
async function readNodes(scope: GraphScope, client: PoolClient): Promise<GraphNodeInput[]> {
  const sql =
    scope.kind === 'project'
      ? `SELECT s.id AS spec_id, s.section, s.title
           FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
          WHERE ps.project_id = $1 AND s.withdrawn_at IS NULL
          ORDER BY s.section, s.id`
      : `SELECT s.id AS spec_id, s.section, s.title
           FROM specs s
          WHERE s.library_id = $1 AND s.withdrawn_at IS NULL
          ORDER BY s.section, s.id`;
  const r = await client.query<NodeRow>(sql, [scope.id]);
  return r.rows.map((row) => ({ specId: row.spec_id, section: row.section, title: row.title }));
}

async function readSectionRefs(
  specIds: readonly string[],
  client: PoolClient
): Promise<GraphRefRowInput[]> {
  if (specIds.length === 0) return [];
  // Ordered so the per-edge anchor cap (ANCHOR_CAP) yields a deterministic
  // subset for high-citation edges — without ORDER BY, Postgres row order (and
  // thus which anchors survive slice(0, ANCHOR_CAP)) is not guaranteed stable.
  const r = await client.query<RefRow>(
    `SELECT source_spec_id, target_spec_section, source_paragraph_id
       FROM spec_references
      WHERE source_spec_id = ANY($1::uuid[])
        AND target_type = 'section'
        AND target_spec_section IS NOT NULL
      ORDER BY source_spec_id, target_spec_section, source_paragraph_id`,
    [specIds]
  );
  return r.rows.map((row) => ({
    sourceSpecId: row.source_spec_id,
    targetSection: row.target_spec_section,
    sourceParagraphId: row.source_paragraph_id,
  }));
}

async function assembleGraph(
  scope: GraphScope,
  includeAnchors: boolean,
  client: PoolClient
): Promise<ReferenceGraph> {
  await assertScopeExists(scope, client);
  const nodes = await readNodes(scope, client);
  const refRows = await readSectionRefs(
    nodes.map((n) => n.specId),
    client
  );
  return buildReferenceGraph({ type: scope.kind, id: scope.id }, nodes, refRows, {
    includeAnchors,
  });
}

/**
 * One-call section-reference graph for a project or library (#447). Reads the
 * in-scope specs and their section references inside a READ ONLY snapshot, then
 * assembles nodes/edges/umbrella via the pure builder. Throws ProjectNotFoundError
 * / LibraryNotFoundError on a missing scope id (mapped to 404 / tool error upstream).
 */
export async function getReferenceGraph(
  scope: GraphScope,
  opts: { readonly includeAnchors?: boolean } = {},
  db: Pool = pool
): Promise<ReferenceGraph> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const graph = await assembleGraph(scope, opts.includeAnchors ?? false, client);
    await client.query('COMMIT');
    return graph;
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) throw err;
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getReferenceGraph failed for ${scope.kind} ${scope.id}`, {
      cause: err,
    });
  } finally {
    if (client) client.release();
  }
}
