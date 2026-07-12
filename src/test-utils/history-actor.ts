import type { Pool } from 'pg';

/**
 * Test-only helper (#377): resolve the actor label attributed to a
 * `paragraph_versions` snapshot at a given version, or `null` when the row has
 * no attributed user. LEFT JOIN so a row whose `user_id` is NULL still returns
 * (as `null`) rather than dropping out. Consolidates the identical query that
 * the paragraph/merge attribution integration suites each reimplemented; the
 * version is passed by the caller (a fixed snapshot version, or a live
 * `base_version` read at the call site) so this stays a single unbranched query.
 */
export async function historyActor(
  pool: Pool,
  paragraphId: string,
  version: number
): Promise<string | null> {
  const row = await pool.query<{ label: string | null }>(
    `SELECT u.label FROM paragraph_versions v
     LEFT JOIN users u ON u.id = v.user_id
     WHERE v.paragraph_id = $1 AND v.version = $2`,
    [paragraphId, version]
  );
  return row.rows[0]?.label ?? null;
}
