import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { getRevisionNomenclatureForProject } from './revision-nomenclature.js';
import { mapSummary } from './revisions.js';
import type { RevisionRow, RevisionSummary } from './revisions.js';

/** Read side of package revisions: enumerate a package's issuance timeline.
 *  The frozen-tree read (getPackageRevision) and the write path (createPackageRevision)
 *  live in revisions.ts; this file carries only the list query so that file stays
 *  under the 400-line cap. Summary mapping is shared via mapSummary. */

interface Queryable {
  query: Pool['query'];
}

interface RevisionListRow extends RevisionRow {
  readonly spec_count: number;
}

interface PackageRow {
  readonly project_id: string;
}

/** Every issued revision of a package as light summaries, ordered by sort_order
 *  (the per-package issuance clock, UNIQUE per migration 028) — the issuance
 *  timeline. Metadata only; the frozen trees stay in getPackageRevision. Returns
 *  null when the package does not exist (→ 404 at the API layer); an empty array
 *  when the package exists but has issued nothing yet. */
export async function listPackageRevisions(
  packageId: string,
  db: Queryable = pool
): Promise<readonly RevisionSummary[] | null> {
  try {
    const pkg = await db.query<PackageRow>('SELECT project_id FROM design_packages WHERE id = $1', [
      packageId,
    ]);
    const pkgRow = pkg.rows[0];
    if (!pkgRow) return null;
    const profile = await getRevisionNomenclatureForProject(pkgRow.project_id, db);
    const res = await db.query<RevisionListRow>(
      `SELECT pr.id, pr.package_id, pr.label, pr.revision_type, pr.revision_date,
              pr.sort_order, pr.attributes, pr.issued_at, pr.parent_revision_id,
              pr.base_revision_id,
              (SELECT COUNT(*)::int FROM package_revision_specs prs
               WHERE prs.revision_id = pr.id) AS spec_count
       FROM package_revisions pr
       WHERE pr.package_id = $1
       ORDER BY pr.sort_order`,
      [packageId]
    );
    return res.rows.map((row) => mapSummary(row, profile, row.spec_count));
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`listPackageRevisions: query failed for package ${packageId}`, {
      cause: err,
    });
  }
}
