import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { logger } from '../../lib/logger.js';

/** Design packages (ADR-015 D4, issue #95): named, ordered, issuable subsets
 *  of the project TOC. Membership is restricted to the package's own project
 *  — enforced here at the query layer (see migration 020). */

interface Queryable {
  query: Pool['query'];
}

/** Target package does not exist → 404 at the API layer. */
export class PackageNotFoundError extends DatabaseError {}
/** A spec id is not in the package's project TOC → 422 at the API layer. */
export class SpecNotInProjectError extends DatabaseError {}

export interface PackageSpecEntry {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

export interface PackageSummary {
  readonly packageId: string;
  readonly projectId: string;
  readonly name: string;
  readonly position: number;
}

export interface PackageWithSpecs extends PackageSummary {
  readonly specs: readonly PackageSpecEntry[];
}

interface PackageRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly position: number;
}

interface PackageListRow extends PackageRow {
  readonly specs: readonly PackageSpecEntry[] | null;
}

interface EntryRow {
  readonly spec_id: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

export async function createPackage(
  projectId: string,
  name: string,
  db: Queryable
): Promise<PackageSummary> {
  try {
    const res = await db.query<PackageRow>(
      `INSERT INTO design_packages (project_id, name, position)
       SELECT $1, $2, COALESCE(MAX(position), 0) + 1
       FROM design_packages WHERE project_id = $1
       RETURNING id, project_id, name, position`,
      [projectId, name]
    );
    const row = res.rows[0];
    if (!row) throw new DatabaseError('createPackage: no row returned after insert');
    return {
      packageId: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createPackage: insert failed for project ${projectId}`, {
      cause: err,
    });
  }
}

/** Packages in position order, each with its ordered membership. Returns
 *  null when the project does not exist (→ 404 at the API layer). */
export async function listPackages(
  projectId: string,
  db: Queryable
): Promise<readonly PackageWithSpecs[] | null> {
  try {
    const proj = await db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (proj.rowCount === 0) return null;
    const res = await db.query<PackageListRow>(
      `SELECT dp.id, dp.project_id, dp.name, dp.position,
              COALESCE(
                json_agg(json_build_object(
                  'specId', s.id, 'section', s.section, 'title', s.title,
                  'position', ps.position
                ) ORDER BY ps.position) FILTER (WHERE s.id IS NOT NULL),
                '[]'
              ) AS specs
       FROM design_packages dp
       LEFT JOIN package_specs ps ON ps.package_id = dp.id
       LEFT JOIN specs s ON s.id = ps.spec_id
       WHERE dp.project_id = $1
       GROUP BY dp.id, dp.project_id, dp.name, dp.position
       ORDER BY dp.position, dp.id`,
      [projectId]
    );
    return res.rows.map((row) => ({
      packageId: row.id,
      projectId: row.project_id,
      name: row.name,
      position: row.position,
      specs: row.specs ?? [],
    }));
  } catch (err) {
    throw new DatabaseError(`listPackages: query failed for project ${projectId}`, {
      cause: err,
    });
  }
}

/** SELECT ... FOR UPDATE; resolves the owning project (404 surface if gone). */
async function lockPackage(packageId: string, client: PoolClient): Promise<string> {
  const res = await client.query<{ project_id: string }>(
    'SELECT project_id FROM design_packages WHERE id = $1 FOR UPDATE',
    [packageId]
  );
  const row = res.rows[0];
  if (!row) throw new PackageNotFoundError(`setPackageSpecs: package ${packageId} not found`);
  return row.project_id;
}

/** Membership must be a subset of the package's own project TOC (ADR-015 D4). */
async function assertSpecsInProject(
  projectId: string,
  specIds: readonly string[],
  client: PoolClient
): Promise<void> {
  if (specIds.length === 0) return;
  const res = await client.query<{ spec_id: string }>(
    'SELECT spec_id FROM project_specs WHERE project_id = $1 AND spec_id = ANY($2::uuid[])',
    [projectId, specIds]
  );
  const present = new Set(res.rows.map((row) => row.spec_id));
  const missing = specIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    // User-facing via the 422 surface — no internal function-name prefix.
    throw new SpecNotInProjectError(
      `specs not in this package's project TOC: ${missing.join(', ')}`
    );
  }
}

/** Full-replacement ordered membership: position = array order (1-based).
 *  Empty array clears the package. One transaction; all-or-nothing. */
export async function setPackageSpecs(
  packageId: string,
  specIds: readonly string[],
  db: Pool = pool
): Promise<readonly PackageSpecEntry[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const projectId = await lockPackage(packageId, client);
    await assertSpecsInProject(projectId, specIds, client);
    await client.query('DELETE FROM package_specs WHERE package_id = $1', [packageId]);
    const res = await client.query<EntryRow>(
      `WITH inserted AS (
         INSERT INTO package_specs (package_id, spec_id, position)
         SELECT $1, u.spec_id, u.ord::int
         FROM unnest($2::uuid[]) WITH ORDINALITY AS u(spec_id, ord)
         RETURNING spec_id, position
       )
       SELECT i.spec_id, s.section, s.title, i.position
       FROM inserted i JOIN specs s ON s.id = i.spec_id
       ORDER BY i.position`,
      [packageId, specIds]
    );
    await client.query('COMMIT');
    logger.info({ packageId, count: specIds.length }, 'setPackageSpecs: membership replaced');
    return res.rows.map((row) => ({
      specId: row.spec_id,
      section: row.section,
      title: row.title,
      position: row.position,
    }));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setPackageSpecs: failed for package ${packageId}`, { cause: err });
  } finally {
    client.release();
  }
}

/** Membership rows cascade (migration 020). Returns false when unknown → 404. */
export async function deletePackage(packageId: string, db: Queryable): Promise<boolean> {
  try {
    const res = await db.query('DELETE FROM design_packages WHERE id = $1', [packageId]);
    const deleted = (res.rowCount ?? 0) > 0;
    if (deleted) logger.info({ packageId }, 'deletePackage: package deleted');
    return deleted;
  } catch (err) {
    throw new DatabaseError(`deletePackage: failed for ${packageId}`, { cause: err });
  }
}
