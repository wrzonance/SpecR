import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import type { OriginMeta } from './specs.js';

/** ADR-015 D6 — read-only custody chain. Walks specs.parent_spec_id to the
 *  root; per-hop drift (behindBy) = parent's current content_version minus
 *  this copy's clone-time origin_version (ADR-015 D2). */

export type LineageScope = 'library' | 'project';

export interface LineageHop {
  readonly specId: string;
  readonly scope: LineageScope;
  readonly name: string;
  readonly contentVersion: number;
  readonly originVersion: number | null;
  readonly behindBy: number | null;
}

export interface SpecLineage {
  readonly chain: readonly LineageHop[];
  /** Ingest provenance of the chain root; null when the root was never file-ingested. */
  readonly originMeta: OriginMeta | null;
}

interface LineageRow {
  readonly id: string;
  readonly scope: LineageScope;
  readonly name: string;
  readonly content_version: number;
  readonly origin_version: number | null;
  readonly origin_meta: OriginMeta | null;
  readonly parent_content_version: number | null;
}

function toHop(row: LineageRow): LineageHop {
  const behindBy =
    row.parent_content_version !== null && row.origin_version !== null
      ? row.parent_content_version - row.origin_version
      : null;
  return {
    specId: row.id,
    scope: row.scope,
    name: row.name,
    contentVersion: row.content_version,
    originVersion: row.origin_version,
    behindBy,
  };
}

/** Walk the derivation chain from `id` to its root. Returns null when the
 *  spec does not exist. The recursive walk is cycle-guarded (path array) —
 *  a corrupt self-referencing chain terminates instead of looping. */
export async function getSpecLineage(id: string): Promise<SpecLineage | null> {
  try {
    const result = await pool.query<LineageRow>(
      `WITH RECURSIVE chain AS (
         SELECT s.id, s.parent_spec_id, s.origin_version, s.content_version,
                s.origin_meta, s.library_id, s.project_id,
                0 AS depth, ARRAY[s.id] AS path
         FROM specs s WHERE s.id = $1
         UNION ALL
         SELECT p.id, p.parent_spec_id, p.origin_version, p.content_version,
                p.origin_meta, p.library_id, p.project_id,
                c.depth + 1, c.path || p.id
         FROM specs p
         JOIN chain c ON p.id = c.parent_spec_id
         WHERE NOT p.id = ANY(c.path)
       )
       SELECT c.id,
              CASE WHEN c.project_id IS NOT NULL THEN 'project' ELSE 'library' END AS scope,
              COALESCE(pr.name, l.name, '') AS name,
              c.content_version, c.origin_version, c.origin_meta,
              parent.content_version AS parent_content_version
       FROM chain c
       LEFT JOIN libraries l ON l.id = c.library_id
       LEFT JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN specs parent ON parent.id = c.parent_spec_id
       ORDER BY c.depth`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const chain = result.rows.map(toHop);
    const root = result.rows[result.rows.length - 1];
    return { chain, originMeta: root?.origin_meta ?? null };
  } catch (err) {
    throw new DatabaseError('getSpecLineage failed', { cause: err });
  }
}
