import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';
import {
  listRequiredSections,
  type RequiredScope,
  type RequiredSection,
} from './required-sections.js';
import { getBrokenRefs, type BrokenRef } from './projects.js';

interface Queryable {
  query: Pool['query'];
}

export type Finding =
  | {
      readonly type: 'required_not_present';
      readonly section: string;
      readonly title: string | null;
      readonly requiredId: string;
    }
  | {
      readonly type: 'present_not_required';
      readonly section: string;
      readonly specId: string;
      readonly title: string;
    }
  | {
      readonly type: 'dangling_ref';
      readonly refId: string;
      readonly sourceSpecId: string;
      readonly sourceSpecSection: string;
      readonly targetSpecSection: string;
      readonly referenceText: string;
      readonly availableFrom: readonly { readonly libraryId: string; readonly name: string }[];
    };

export interface CoordinationSummary {
  readonly requiredNotPresent: number;
  readonly presentNotRequired: number;
  readonly danglingRef: number;
  readonly total: number;
}

export interface CoordinationReport {
  readonly projectId: string;
  readonly packageId: string | null;
  readonly findings: readonly Finding[];
  readonly summary: CoordinationSummary;
  readonly notes: readonly string[];
}

interface PresentSpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}

const EMPTY_REQUIRED_NOTE =
  'no required sections authored at this scope — present/required comparison skipped';

async function assertScope(
  projectId: string,
  packageId: string | undefined,
  client: Queryable
): Promise<void> {
  const proj = await client.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
  if ((proj.rowCount ?? 0) === 0) {
    throw new ProjectNotFoundError(`project ${projectId} not found`);
  }
  if (packageId !== undefined) {
    const pkg = await client.query(
      `SELECT 1 FROM design_packages WHERE id = $1 AND project_id = $2`,
      [packageId, projectId]
    );
    if ((pkg.rowCount ?? 0) === 0) {
      throw new PackageNotFoundError(`package ${packageId} not found in project ${projectId}`);
    }
  }
}

async function readPresent(
  projectId: string,
  packageId: string | undefined,
  client: Queryable
): Promise<readonly PresentSpec[]> {
  const sql =
    packageId === undefined
      ? `SELECT s.id AS spec_id, s.section, s.title
         FROM project_specs ps JOIN specs s ON s.id = ps.spec_id
         WHERE ps.project_id = $1 ORDER BY s.section`
      : `SELECT s.id AS spec_id, s.section, s.title
         FROM package_specs ks JOIN specs s ON s.id = ks.spec_id
         WHERE ks.package_id = $1 ORDER BY s.section`;
  const r = await client.query<{ spec_id: string; section: string; title: string }>(sql, [
    packageId ?? projectId,
  ]);
  return r.rows.map((row) => ({ specId: row.spec_id, section: row.section, title: row.title }));
}

function requiredScope(projectId: string, packageId: string | undefined): RequiredScope {
  return packageId === undefined
    ? { kind: 'baseline', projectId }
    : { kind: 'package', projectId, packageId };
}

function toDangling(
  b: BrokenRef,
  presentIds: ReadonlySet<string>,
  requiredSections: ReadonlySet<string>
): Finding | null {
  const target = b.targetSpecSection;
  if (target === null || !presentIds.has(b.sourceSpecId) || requiredSections.has(target)) {
    return null;
  }
  return {
    type: 'dangling_ref',
    refId: b.refId,
    sourceSpecId: b.sourceSpecId,
    sourceSpecSection: b.sourceSpecSection,
    targetSpecSection: target,
    referenceText: b.referenceText,
    availableFrom: b.availableFrom,
  };
}

function buildFindings(
  required: readonly RequiredSection[],
  present: readonly PresentSpec[],
  broken: readonly BrokenRef[]
): { readonly findings: readonly Finding[]; readonly notes: readonly string[] } {
  const requiredSections = new Set(required.map((r) => r.section));
  const presentSections = new Set(present.map((p) => p.section));
  const presentIds = new Set(present.map((p) => p.specId));

  const requiredNotPresent: Finding[] = required
    .filter((r) => !presentSections.has(r.section))
    .map((r) => ({
      type: 'required_not_present',
      section: r.section,
      title: r.title,
      requiredId: r.id,
    }));

  const empty = requiredSections.size === 0;
  const presentNotRequired: Finding[] = empty
    ? []
    : present
        .filter((p) => !requiredSections.has(p.section))
        .map((p) => ({
          type: 'present_not_required',
          section: p.section,
          specId: p.specId,
          title: p.title,
        }));

  const danglingRef = broken.flatMap((b) => {
    const f = toDangling(b, presentIds, requiredSections);
    return f ? [f] : [];
  });

  return {
    findings: [...requiredNotPresent, ...presentNotRequired, ...danglingRef],
    notes: empty ? [EMPTY_REQUIRED_NOTE] : [],
  };
}

function summarize(findings: readonly Finding[]): CoordinationSummary {
  const count = (t: Finding['type']): number => findings.filter((f) => f.type === t).length;
  return {
    requiredNotPresent: count('required_not_present'),
    presentNotRequired: count('present_not_required'),
    danglingRef: count('dangling_ref'),
    total: findings.length,
  };
}

export async function getCoordinationReport(
  projectId: string,
  packageId: string | undefined,
  db: Pool = pool
): Promise<CoordinationReport> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertScope(projectId, packageId, client);
    const required = await listRequiredSections(requiredScope(projectId, packageId), client);
    const present = await readPresent(projectId, packageId, client);
    const broken = await getBrokenRefs(projectId, client);
    await client.query('COMMIT');
    const { findings, notes } = buildFindings(required, present, broken);
    return {
      projectId,
      packageId: packageId ?? null,
      findings,
      summary: summarize(findings),
      notes,
    };
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getCoordinationReport failed for project ${projectId}`, {
      cause: err,
    });
  } finally {
    if (client) client.release();
  }
}
