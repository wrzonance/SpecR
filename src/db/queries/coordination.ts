import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

export interface RequiredSectionInput {
  readonly section: string;
  readonly title?: string;
}

export interface RequiredSectionEntry {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

export type CoordinationFinding =
  | {
      readonly type: 'present_not_required';
      readonly section: string;
      readonly specId: string;
      readonly title: string;
    }
  | {
      readonly type: 'required_not_present';
      readonly section: string;
      readonly title: string | null;
      readonly requiredId: string;
    }
  | {
      readonly type: 'dangling_ref';
      readonly refId: string;
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly targetSpecSection: string | null;
      readonly referenceText: string;
    };

export interface CoordinationReportSummary {
  readonly presentNotRequired: number;
  readonly requiredNotPresent: number;
  readonly danglingRef: number;
  readonly total: number;
}

export interface CoordinationReport {
  readonly projectId: string;
  readonly packageId: string | null;
  readonly findings: readonly CoordinationFinding[];
  readonly summary: CoordinationReportSummary;
  readonly notes: readonly string[];
}

interface RequiredSectionRow {
  readonly id: string;
  readonly section: string;
  readonly title: string | null;
  readonly position: number;
}

interface PackageScopeRow {
  readonly project_id: string;
}

interface ReportRow {
  readonly project_exists: boolean;
  readonly package_project_id: string | null;
  readonly required_count: string;
  readonly present_not_required: CoordinationFinding[] | null;
  readonly required_not_present: CoordinationFinding[] | null;
  readonly dangling_ref: CoordinationFinding[] | null;
}

const REPORT_SQL = `WITH project_probe AS (
  SELECT id FROM projects WHERE id = $1
),
package_probe AS (
  SELECT project_id FROM design_packages WHERE id = $2::uuid
),
present AS (
  SELECT s.id AS spec_id, s.section, s.title
  FROM project_specs ps
  JOIN specs s ON s.id = ps.spec_id
  WHERE ps.project_id = $1 AND $2::uuid IS NULL
  UNION ALL
  SELECT s.id AS spec_id, s.section, s.title
  FROM package_specs ps
  JOIN specs s ON s.id = ps.spec_id
  JOIN design_packages dp ON dp.id = ps.package_id
  WHERE ps.package_id = $2::uuid AND dp.project_id = $1 AND $2::uuid IS NOT NULL
),
required AS (
  SELECT id, section, title
  FROM required_sections
  WHERE project_id = $1
    AND (($2::uuid IS NULL AND package_id IS NULL) OR package_id = $2::uuid)
),
required_count AS (
  SELECT COUNT(*)::text AS count FROM required
),
scope_sections AS (
  SELECT section FROM present
  UNION
  SELECT section FROM required
),
present_not_required_rows AS (
  SELECT json_build_object(
    'type', 'present_not_required',
    'section', p.section,
    'specId', p.spec_id,
    'title', p.title
  ) AS finding,
  p.section,
  p.spec_id
  FROM present p
  WHERE (SELECT count FROM required_count)::int > 0
    AND NOT EXISTS (SELECT 1 FROM required r WHERE r.section = p.section)
),
required_not_present_rows AS (
  SELECT json_build_object(
    'type', 'required_not_present',
    'section', r.section,
    'title', r.title,
    'requiredId', r.id
  ) AS finding,
  r.section,
  r.id
  FROM required r
  WHERE NOT EXISTS (SELECT 1 FROM present p WHERE p.section = r.section)
),
dangling_ref_rows AS (
  SELECT json_build_object(
    'type', 'dangling_ref',
    'refId', sr.id,
    'sourceSpecId', sr.source_spec_id,
    'sourceSpecSection', p.section,
    'targetSpecSection', sr.target_spec_section,
    'referenceText', sr.reference_text
  ) AS finding,
  p.section,
  sr.id
  FROM spec_references sr
  JOIN present p ON p.spec_id = sr.source_spec_id
  WHERE sr.target_type = 'section'
    AND sr.target_spec_section IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM scope_sections ss WHERE ss.section = sr.target_spec_section)
)
SELECT
  EXISTS (SELECT 1 FROM project_probe) AS project_exists,
  (SELECT project_id FROM package_probe) AS package_project_id,
  (SELECT count FROM required_count) AS required_count,
  COALESCE((SELECT json_agg(finding ORDER BY section, spec_id) FROM present_not_required_rows), '[]') AS present_not_required,
  COALESCE((SELECT json_agg(finding ORDER BY section, id) FROM required_not_present_rows), '[]') AS required_not_present,
  COALESCE((SELECT json_agg(finding ORDER BY section, id) FROM dangling_ref_rows), '[]') AS dangling_ref`;

async function lockProject(projectId: string, client: PoolClient): Promise<void> {
  const res = await client.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  if (res.rowCount === 0) {
    throw new ProjectNotFoundError(`setProjectRequiredSections: project ${projectId} not found`);
  }
}

async function lockPackage(packageId: string, client: PoolClient): Promise<string> {
  const res = await client.query<PackageScopeRow>(
    'SELECT project_id FROM design_packages WHERE id = $1 FOR UPDATE',
    [packageId]
  );
  const row = res.rows[0];
  if (!row) {
    throw new PackageNotFoundError(`setPackageRequiredSections: package ${packageId} not found`);
  }
  return row.project_id;
}

function mapRequired(rows: readonly RequiredSectionRow[]): readonly RequiredSectionEntry[] {
  return rows.map((row) => ({
    id: row.id,
    section: row.section,
    title: row.title,
    position: row.position,
  }));
}

async function insertRequiredSections(
  projectId: string,
  packageId: string | null,
  items: readonly RequiredSectionInput[],
  client: PoolClient
): Promise<readonly RequiredSectionEntry[]> {
  const sections = items.map((item) => item.section);
  const titles = items.map((item) => item.title ?? null);
  const res = await client.query<RequiredSectionRow>(
    `WITH inserted AS (
       INSERT INTO required_sections (project_id, package_id, section, title, position)
       SELECT $1, $2, u.section, u.title, u.ord::int
       FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS u(section, title, ord)
       RETURNING id, section, title, position
     )
     SELECT id, section, title, position FROM inserted ORDER BY position`,
    [projectId, packageId, sections, titles]
  );
  return mapRequired(res.rows);
}

export async function setProjectRequiredSections(
  projectId: string,
  items: readonly RequiredSectionInput[],
  db: Pool = pool
): Promise<readonly RequiredSectionEntry[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockProject(projectId, client);
    await client.query(
      'DELETE FROM required_sections WHERE project_id = $1 AND package_id IS NULL',
      [projectId]
    );
    const rows = await insertRequiredSections(projectId, null, items, client);
    await client.query('COMMIT');
    logger.info({ projectId, count: items.length }, 'setProjectRequiredSections: replaced');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setProjectRequiredSections: failed for project ${projectId}`, {
      cause: err,
    });
  } finally {
    client.release();
  }
}

export async function setPackageRequiredSections(
  packageId: string,
  items: readonly RequiredSectionInput[],
  db: Pool = pool
): Promise<readonly RequiredSectionEntry[]> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const projectId = await lockPackage(packageId, client);
    await client.query('DELETE FROM required_sections WHERE package_id = $1', [packageId]);
    const rows = await insertRequiredSections(projectId, packageId, items, client);
    await client.query('COMMIT');
    logger.info({ packageId, count: items.length }, 'setPackageRequiredSections: replaced');
    return rows;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setPackageRequiredSections: failed for package ${packageId}`, {
      cause: err,
    });
  } finally {
    client.release();
  }
}

export async function listProjectRequiredSections(
  projectId: string,
  db: Queryable
): Promise<readonly RequiredSectionEntry[] | null> {
  try {
    const proj = await db.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (proj.rowCount === 0) return null;
    const res = await db.query<RequiredSectionRow>(
      `SELECT id, section, title, position
       FROM required_sections
       WHERE project_id = $1 AND package_id IS NULL
       ORDER BY position`,
      [projectId]
    );
    return mapRequired(res.rows);
  } catch (err) {
    throw new DatabaseError(`listProjectRequiredSections: failed for project ${projectId}`, {
      cause: err,
    });
  }
}

export async function listPackageRequiredSections(
  packageId: string,
  db: Queryable
): Promise<readonly RequiredSectionEntry[] | null> {
  try {
    const pkg = await db.query<PackageScopeRow>('SELECT 1 FROM design_packages WHERE id = $1', [
      packageId,
    ]);
    if (pkg.rowCount === 0) return null;
    const res = await db.query<RequiredSectionRow>(
      `SELECT id, section, title, position
       FROM required_sections
       WHERE package_id = $1
       ORDER BY position`,
      [packageId]
    );
    return mapRequired(res.rows);
  } catch (err) {
    throw new DatabaseError(`listPackageRequiredSections: failed for package ${packageId}`, {
      cause: err,
    });
  }
}

function buildSummary(
  presentNotRequired: readonly CoordinationFinding[],
  requiredNotPresent: readonly CoordinationFinding[],
  danglingRef: readonly CoordinationFinding[]
): CoordinationReportSummary {
  const counts = {
    presentNotRequired: presentNotRequired.length,
    requiredNotPresent: requiredNotPresent.length,
    danglingRef: danglingRef.length,
  };
  return {
    ...counts,
    total: counts.presentNotRequired + counts.requiredNotPresent + counts.danglingRef,
  };
}

function notesForRequiredCount(requiredCount: string): readonly string[] {
  if (Number(requiredCount) > 0) return [];
  return ['no required sections authored - present-not-required findings suppressed'];
}

function reportFromRow(
  projectId: string,
  packageId: string | undefined,
  row: ReportRow
): CoordinationReport {
  const presentNotRequired = row.present_not_required ?? [];
  const requiredNotPresent = row.required_not_present ?? [];
  const danglingRef = row.dangling_ref ?? [];
  return {
    projectId,
    packageId: packageId ?? null,
    findings: [...presentNotRequired, ...requiredNotPresent, ...danglingRef],
    summary: buildSummary(presentNotRequired, requiredNotPresent, danglingRef),
    notes: notesForRequiredCount(row.required_count),
  };
}

function assertPackageScope(
  projectId: string,
  packageId: string | undefined,
  row: ReportRow
): void {
  if (packageId === undefined || row.package_project_id === projectId) return;
  throw new PackageNotFoundError(`getCoordinationReport: package ${packageId} not found`);
}

export async function getCoordinationReport(
  projectId: string,
  packageId: string | undefined,
  db: Queryable
): Promise<CoordinationReport | null> {
  try {
    const res = await db.query<ReportRow>(REPORT_SQL, [projectId, packageId ?? null]);
    const row = res.rows[0];
    if (!row?.project_exists) return null;
    assertPackageScope(projectId, packageId, row);
    return reportFromRow(projectId, packageId, row);
  } catch (err) {
    if (err instanceof PackageNotFoundError) throw err;
    throw new DatabaseError(`getCoordinationReport: failed for project ${projectId}`, {
      cause: err,
    });
  }
}
