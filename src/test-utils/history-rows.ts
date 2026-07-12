import type { Pool } from 'pg';

/**
 * Test-only helper (#377): every paragraph_versions snapshot row for a
 * paragraph, oldest version first, in the raw column shape. Shared by the
 * insert/vanish/reclassify attribution suites, which each reimplemented this
 * identical row shape + query. `payload` stays `unknown` — each suite asserts
 * its own op-specific payload at the call site.
 *
 * The merge/conflict suite keeps its own variant: it maps these columns to a
 * camelCase shape for its assertions, a deliberately different contract rather
 * than this raw one.
 */
export interface HistoryRow {
  readonly version: number;
  readonly text: string;
  readonly node_type: string;
  readonly op: string;
  readonly spec_id: string;
  readonly content_version: number;
  readonly payload: unknown;
}

export async function historyRowsFor(
  pool: Pool,
  paragraphId: string
): Promise<readonly HistoryRow[]> {
  const res = await pool.query<HistoryRow>(
    `SELECT version, text, node_type, op, spec_id, content_version, payload
     FROM paragraph_versions WHERE paragraph_id = $1 ORDER BY version`,
    [paragraphId]
  );
  return res.rows;
}
