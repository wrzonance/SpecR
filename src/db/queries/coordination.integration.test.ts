import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../index.js';
import { PackageNotFoundError } from './packages.js';
import {
  getCoordinationReport,
  listProjectRequiredSections,
  setPackageRequiredSections,
  setProjectRequiredSections,
} from './coordination.js';

const ZERO = '00000000-0000-0000-0000-000000000000';
const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];

async function insertProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('insertProject failed');
  projectIds.push(id);
  return id;
}

async function insertSpec(section: string, title: string, source: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [section, title, source, companyLibraryId]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('insertSpec failed');
  specIds.push(id);
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}

async function addRef(sourceSpecId: string, targetSection: string): Promise<void> {
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'article', $2, 1) RETURNING id`,
    [sourceSpecId, `See Section ${targetSection}`]
  );
  const paraId = para.rows[0]?.id;
  if (!paraId) throw new Error('insert paragraph failed');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', $3, $4)`,
    [sourceSpecId, paraId, targetSection, `See Section ${targetSection}`]
  );
}

let projectId: string;
let concrete: string;
let steel: string;
let companyLibraryId: string;

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  companyLibraryId = lib.rows[0]?.id ?? '';
  projectId = await insertProject(`coord-query-${suffix}`);
  concrete = await insertSpec('03 30 00', 'Concrete', `cq-${suffix}-c`);
  steel = await insertSpec('05 12 00', 'Steel', `cq-${suffix}-s`);
  await addProjectSpec(projectId, concrete, 1);
  await addProjectSpec(projectId, steel, 2);
  await addRef(concrete, '07 21 00');
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM required_sections WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM spec_references WHERE source_spec_id = ANY($1)', [specIds]);
  await pool.query('DELETE FROM paragraphs WHERE spec_id = ANY($1)', [specIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [specIds]);
});

describe('required section CRUD', () => {
  it('setProjectRequiredSections full-replaces in array order', async () => {
    const rows = await setProjectRequiredSections(
      projectId,
      [
        { section: '05 12 00', title: 'Steel' },
        { section: '09 91 00', title: 'Painting' },
      ],
      pool
    );
    expect(rows.map((row) => [row.section, row.position])).toEqual([
      ['05 12 00', 1],
      ['09 91 00', 2],
    ]);
    await setProjectRequiredSections(projectId, [{ section: '03 30 00' }], pool);
    const listed = await listProjectRequiredSections(projectId, pool);
    expect(listed?.map((row) => [row.section, row.title, row.position])).toEqual([
      ['03 30 00', null, 1],
    ]);
  });

  it('empty array clears', async () => {
    await setProjectRequiredSections(projectId, [{ section: '03 30 00' }], pool);
    await setProjectRequiredSections(projectId, [], pool);
    await expect(listProjectRequiredSections(projectId, pool)).resolves.toEqual([]);
  });

  it('listProjectRequiredSections returns null for unknown', async () => {
    await expect(listProjectRequiredSections(ZERO, pool)).resolves.toBeNull();
  });
});

describe('getCoordinationReport', () => {
  it('returns null for unknown project', async () => {
    await expect(getCoordinationReport(ZERO, undefined, pool)).resolves.toBeNull();
  });

  it('reports all three finding types and summary counts', async () => {
    await setProjectRequiredSections(
      projectId,
      [
        { section: '03 30 00', title: 'Concrete' },
        { section: '09 91 00', title: 'Painting' },
      ],
      pool
    );
    const report = await getCoordinationReport(projectId, undefined, pool);
    expect(report?.summary).toEqual({
      presentNotRequired: 1,
      requiredNotPresent: 1,
      danglingRef: 1,
      total: 3,
    });
    expect(report?.findings.map((f) => f.type)).toEqual([
      'present_not_required',
      'required_not_present',
      'dangling_ref',
    ]);
  });

  it('does not flag dangling when target is required-but-absent', async () => {
    await setProjectRequiredSections(projectId, [{ section: '07 21 00' }], pool);
    const report = await getCoordinationReport(projectId, undefined, pool);
    expect(report?.findings.filter((f) => f.type === 'dangling_ref')).toEqual([]);
  });

  it('suppresses mode 1 and emits note when required list is empty', async () => {
    await setProjectRequiredSections(projectId, [], pool);
    const report = await getCoordinationReport(projectId, undefined, pool);
    expect(report?.summary.presentNotRequired).toBe(0);
    expect(report?.summary.danglingRef).toBe(1);
    expect(report?.notes).toHaveLength(1);
  });

  it('scopes package present specs and package-level requirements only', async () => {
    await setProjectRequiredSections(projectId, [{ section: '03 30 00' }], pool);
    const pkg = await pool.query<{ id: string }>(
      `INSERT INTO design_packages (project_id, name, position)
       VALUES ($1, 'coord pkg', 1) RETURNING id`,
      [projectId]
    );
    const packageId = pkg.rows[0]?.id;
    if (!packageId) throw new Error('insert package failed');
    await pool.query(
      `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, 1)`,
      [packageId, steel]
    );
    await setPackageRequiredSections(packageId, [{ section: '09 91 00' }], pool);
    const report = await getCoordinationReport(projectId, packageId, pool);
    expect(report?.findings.map((f) => [f.type, 'section' in f ? f.section : null])).toEqual([
      ['present_not_required', '05 12 00'],
      ['required_not_present', '09 91 00'],
    ]);
    await expect(getCoordinationReport(projectId, ZERO, pool)).rejects.toThrow(
      PackageNotFoundError
    );
  });
});
