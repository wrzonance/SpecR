import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../index.js';
import { getCoordinationReport, type Finding } from './coordination.js';
import { setRequiredSections } from './required-sections.js';
import { ProjectNotFoundError } from './derive.js';
import { PackageNotFoundError } from './packages.js';

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let specCounter = 0;

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${name}-${suffix}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newProject: no id');
  projectIds.push(id);
  return id;
}
// Inserts a LIBRARY master (library_id set ⇒ project_id NULL by the
// (library_id IS NULL) <> (project_id IS NULL) CHECK), so it never references a
// project. Track the id and delete it in afterAll — specs.project_id is RESTRICT
// and library specs are not cascaded by project deletion (mirrors refs.integration.test.ts).
async function newSpec(section: string, title: string): Promise<string> {
  // source must be ≤20 chars and unique per (section, library_id); use a short counter.
  const src = `cd_${suffix}_${String(++specCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, src]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}
async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}
async function newPackage(projectId: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, name]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newPackage: no id');
  return id;
}
async function addPackageSpec(packageId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, $3)`,
    [packageId, specId, position]
  );
}
// A section-targeted ref; is_broken = (the target section has no spec in the project).
// `paragraphText` defaults to the bare referenceText (the common case); pass a
// longer sentence to exercise snippet windowing. Returns the paragraph id so a
// test can assert the dangling_ref finding's paragraph-level locator (#260).
async function addRef(
  sourceSpecId: string,
  targetSection: string,
  referenceText: string,
  targetSpecId: string | null,
  paragraphText: string = referenceText
): Promise<string> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', $2, 1) RETURNING id`,
    [sourceSpecId, paragraphText]
  );
  const paragraphId = p.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('addRef: no paragraph id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, reference_text, is_broken)
     VALUES ($1, $2, 'section', $3, $4, $5, $6)`,
    [sourceSpecId, paragraphId, targetSection, targetSpecId, referenceText, targetSpecId === null]
  );
  return paragraphId;
}
// Narrowing filter: ofType(fs, 'dangling_ref') is typed to the dangling variant,
// so variant-specific fields (.targetSpecSection, .section, .specId) typecheck.
function ofType<T extends Finding['type']>(
  fs: readonly Finding[],
  t: T
): Extract<Finding, { type: T }>[] {
  return fs.filter((f): f is Extract<Finding, { type: T }> => f.type === t);
}

afterAll(async () => {
  // Projects first (cascades project_specs/package_specs/required_sections/design_packages),
  // then the library specs we created (cascades their paragraphs + spec_references).
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
});

describe('getCoordinationReport', () => {
  it('returns exactly one finding of each class and excludes required-but-absent refs', async () => {
    const projectId = await newProject('coord-each');
    const specA = await newSpec('03 30 00', 'Concrete'); // present + required
    const specB = await newSpec('05 12 00', 'Steel'); // present, NOT required
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await setRequiredSections({ kind: 'baseline', projectId }, [
      { section: '03 30 00' }, // present → no finding
      { section: '07 92 00', title: 'Joint Sealants' }, // required, absent → required_not_present
    ]);
    await addRef(specA, '09 91 00', 'see 09 91 00', null); // neither → dangling_ref
    await addRef(specB, '07 92 00', 'see 07 92 00', null); // broken but REQUIRED → NOT dangling

    const report = await getCoordinationReport(projectId, undefined);

    expect(report.projectId).toBe(projectId);
    expect(report.packageId).toBeNull();
    expect(ofType(report.findings, 'required_not_present').map((f) => f.section)).toEqual([
      '07 92 00',
    ]);
    expect(ofType(report.findings, 'present_not_required').map((f) => f.section)).toEqual([
      '05 12 00',
    ]);
    expect(ofType(report.findings, 'dangling_ref').map((f) => f.targetSpecSection)).toEqual([
      '09 91 00',
    ]);
    expect(report.summary).toEqual({
      requiredNotPresent: 1,
      presentNotRequired: 1,
      danglingRef: 1,
      total: 3,
    });
    expect(report.notes).toEqual([]);
  });

  it('dangling_ref carries the source paragraph id and a snippet of the ref in context (#260)', async () => {
    const projectId = await newProject('coord-locator');
    const specA = await newSpec('03 30 00', 'Concrete');
    await addProjectSpec(projectId, specA, 1);
    const longText =
      'Coordinate the work of this Section with the requirements of ' +
      'Section 07 84 00 Firestopping, which is not included in this project ' +
      'and must be provided under a separate contract by the Owner.';
    const paragraphId = await addRef(specA, '07 84 00', 'Section 07 84 00', null, longText);

    const report = await getCoordinationReport(projectId, undefined);
    const dangling = ofType(report.findings, 'dangling_ref');

    expect(dangling).toHaveLength(1);
    const finding = dangling[0];
    if (finding === undefined) throw new Error('expected a dangling_ref finding');
    expect(finding.sourceParagraphId).toBe(paragraphId);
    expect(finding.snippet).toContain('Section 07 84 00');
    // Windowed: shorter than the full paragraph, ends with an ellipsis.
    expect(finding.snippet.length).toBeLessThan(longText.length);
    expect(finding.snippet.endsWith('…')).toBe(true);
  });

  it('suppresses present_not_required and emits a note when the required list is empty', async () => {
    const projectId = await newProject('coord-empty');
    const specA = await newSpec('03 30 00', 'Concrete');
    await addProjectSpec(projectId, specA, 1);
    await addRef(specA, '09 91 00', 'see 09 91 00', null); // dangling still runs

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'present_not_required')).toHaveLength(0);
    expect(ofType(report.findings, 'required_not_present')).toHaveLength(0);
    expect(ofType(report.findings, 'dangling_ref')).toHaveLength(1);
    expect(report.notes).toEqual([
      'no required sections authored at this scope — present/required comparison skipped',
    ]);
  });

  it('scopes to a package: package-island required vs package_specs, no baseline union', async () => {
    const projectId = await newProject('coord-pkg');
    const specA = await newSpec('03 30 00', 'Concrete');
    const specB = await newSpec('05 12 00', 'Steel');
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await setRequiredSections({ kind: 'baseline', projectId }, [{ section: '22 00 00' }]); // baseline only
    const packageId = await newPackage(projectId, 'CD set');
    await addPackageSpec(packageId, specA, 1); // package present = {03 30 00}
    await setRequiredSections({ kind: 'package', projectId, packageId }, [
      { section: '03 30 00' }, // present → no finding
      { section: '23 00 00' }, // required, absent → required_not_present
    ]);

    const report = await getCoordinationReport(projectId, packageId);

    expect(report.packageId).toBe(packageId);
    expect(ofType(report.findings, 'required_not_present').map((f) => f.section)).toEqual([
      '23 00 00',
    ]);
    // baseline's 22 00 00 must NOT leak in; specB (not in the package) must not appear
    expect(ofType(report.findings, 'present_not_required')).toHaveLength(0);
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(
      getCoordinationReport('00000000-0000-4000-8000-000000000000', undefined)
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('throws PackageNotFoundError for a packageId not in the project', async () => {
    const projectId = await newProject('coord-badpkg');
    await expect(
      getCoordinationReport(projectId, '00000000-0000-4000-8000-000000000000')
    ).rejects.toBeInstanceOf(PackageNotFoundError);
  });
});
