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
async function addDefaultProjectSource(projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority)
     VALUES ($1, (SELECT id FROM libraries WHERE name = 'Default Company Master'), 1)
     ON CONFLICT (project_id, library_id) DO NOTHING`,
    [projectId]
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
async function newArticle(specId: string, headingText: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'article', $2, $3) RETURNING id`,
    [specId, headingText, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newArticle: no id');
  return id;
}
async function addParagraph(specId: string, text: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'pr1', $2, $3) RETURNING id`,
    [specId, text, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('addParagraph: no id');
  return id;
}
// Body/article ref with explicit target_type + parent. value = canonical section
// or standard_code. Used by the #259 article<->body consistency tests.
async function addClassifiedRef(args: {
  specId: string;
  parentId: string | null;
  text: string;
  targetType: 'section' | 'standard';
  value: string;
}): Promise<string> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, $2, 'pr1', $3, 1) RETURNING id`,
    [args.specId, args.parentId, args.text]
  );
  const pid = p.rows[0]?.id;
  if (pid === undefined) throw new Error('addClassifiedRef: no paragraph id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, standard_code, reference_text)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      args.specId,
      pid,
      args.targetType,
      args.targetType === 'section' ? args.value : null,
      args.targetType === 'standard' ? args.value : null,
      args.text,
    ]
  );
  return pid;
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
    // Both refs sit in the body with no Related Sections article, so each is also
    // a legitimate #259 related_cited_not_listed (cited but not listed).
    expect(
      ofType(report.findings, 'related_cited_not_listed')
        .map((f) => f.section)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['07 92 00', '09 91 00']);
    // X1/ADR-042: the umbrella check now spans every present division. Both
    // present specs omit their DD 00 00 call-out, so both are flagged (div 03/05
    // were silently skipped under the old 26/27/28-only restriction).
    expect(
      ofType(report.findings, 'umbrella_not_called_out')
        .map((f) => f.sourceSpecSection)
        .sort((a, b) => a.localeCompare(b))
    ).toEqual(['03 30 00', '05 12 00']);
    expect(report.summary).toEqual({
      requiredNotPresent: 1,
      presentNotRequired: 1,
      danglingRef: 1,
      relatedListedNotCited: 0,
      relatedCitedNotListed: 2,
      standardCitedNotListed: 0,
      productWithoutSubmittalType: 0,
      submittalTypeWithoutProduct: 0,
      productMissingDatasheet: 0,
      impliedRelatedSection: 0,
      umbrellaNotCalledOut: 2,
      total: 7,
    });
    expect(report.notes).toEqual(['umbrella call-out check covers all divisions in scope: 03, 05']);
  });

  it('coordination: Div 26 subordinate without 26 00 00 citation -> umbrella_not_called_out', async () => {
    const projectId = await newProject('coord-umbrella-missing');
    const spec = await newSpec('26 05 33', 'Raceway and Boxes');
    await addProjectSpec(projectId, spec, 1);

    const report = await getCoordinationReport(projectId, undefined);
    const findings = ofType(report.findings, 'umbrella_not_called_out');

    expect(findings).toEqual([
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: spec,
        sourceSpecSection: '26 05 33',
        umbrellaSpecSection: '26 00 00',
      },
    ]);
    expect(report.summary.umbrellaNotCalledOut).toBe(1);
    // ADR-043: no TOC authored, so the present spec is also present-not-required.
    expect(ofType(report.findings, 'present_not_required').map((f) => f.section)).toEqual([
      '26 05 33',
    ]);
    expect(report.summary.total).toBe(2);
  });

  it('coordination: Div 26 subordinate citing 26 00 00 -> no umbrella_not_called_out', async () => {
    const projectId = await newProject('coord-umbrella-cited');
    const spec = await newSpec('26 05 33', 'Raceway and Boxes');
    await addProjectSpec(projectId, spec, 1);
    await addRef(spec, '26 00 00', 'Section 26 00 00', null);

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'umbrella_not_called_out')).toHaveLength(0);
    expect(report.summary.umbrellaNotCalledOut).toBe(0);
  });

  it('coordination: Div 08 subordinate (outside 26/27/28) without umbrella citation -> flagged, not skipped (ADR-042)', async () => {
    const projectId = await newProject('coord-umbrella-generalized');
    const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
    await addProjectSpec(projectId, spec, 1);

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'umbrella_not_called_out')).toEqual([
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: spec,
        sourceSpecSection: '08 11 13',
        umbrellaSpecSection: '08 00 00',
      },
    ]);
    expect(report.notes).toContain('umbrella call-out check covers all divisions in scope: 08');
  });

  it('#259 A3: lists 07 84 00 under Related Sections but never cites it → related_listed_not_cited', async () => {
    const projectId = await newProject('coord-a3');
    const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
    await addProjectSpec(projectId, spec, 1);
    const related = await newArticle(spec, '1.1 RELATED SECTIONS', 1);
    await addClassifiedRef({
      specId: spec,
      parentId: related,
      text: 'Section 07 84 00',
      targetType: 'section',
      value: '07 84 00',
    });

    const report = await getCoordinationReport(projectId, undefined);
    const f = ofType(report.findings, 'related_listed_not_cited');
    expect(f.map((x) => x.section)).toEqual(['07 84 00']);
    expect(f[0]?.sourceSpecSection).toBe('08 11 13');
    expect(report.summary.relatedListedNotCited).toBe(1);
  });

  it('#259 A2: cites Section 26 05 33 in the body with no Related Sections entry → related_cited_not_listed', async () => {
    const projectId = await newProject('coord-a2');
    const spec = await newSpec('26 27 26', 'Wiring Devices');
    await addProjectSpec(projectId, spec, 1);
    await addClassifiedRef({
      specId: spec,
      parentId: null,
      text: 'Coordinate with Section 26 05 33',
      targetType: 'section',
      value: '26 05 33',
    });

    const report = await getCoordinationReport(projectId, undefined);
    const f = ofType(report.findings, 'related_cited_not_listed');
    expect(f.map((x) => x.section)).toEqual(['26 05 33']);
    expect(report.summary.relatedCitedNotListed).toBe(1);
  });

  it('#259 B2: cites ASTM E814 in the body with no References entry → standard_cited_not_listed; a listed-but-uncited standard yields nothing', async () => {
    const projectId = await newProject('coord-b2');
    const spec = await newSpec('07 84 00', 'Firestopping');
    await addProjectSpec(projectId, spec, 1);
    const refsArticle = await newArticle(spec, '1.02 REFERENCES', 1);
    // listed-but-uncited (B1 non-goal): MUST yield nothing
    await addClassifiedRef({
      specId: spec,
      parentId: refsArticle,
      text: 'ASTM E119',
      targetType: 'standard',
      value: 'ASTM E119',
    });
    // cited-but-unlisted (B2): the finding
    await addClassifiedRef({
      specId: spec,
      parentId: null,
      text: 'Seal per ASTM E814',
      targetType: 'standard',
      value: 'ASTM E814',
    });

    const report = await getCoordinationReport(projectId, undefined);
    const f = ofType(report.findings, 'standard_cited_not_listed');
    expect(f.map((x) => x.standardCode)).toEqual(['ASTM E814']);
    expect(report.summary.standardCitedNotListed).toBe(1);
  });

  it('#259 healthy case: a section both listed under Related Sections AND cited in the body yields no A2/A3', async () => {
    const projectId = await newProject('coord-healthy');
    const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
    await addProjectSpec(projectId, spec, 1);
    const related = await newArticle(spec, '1.1 RELATED SECTIONS', 1);
    // listed under Related Sections
    await addClassifiedRef({
      specId: spec,
      parentId: related,
      text: 'Section 07 84 00',
      targetType: 'section',
      value: '07 84 00',
    });
    // AND cited in the body — the coordinated, healthy case
    await addClassifiedRef({
      specId: spec,
      parentId: null,
      text: 'Seal the head joint per Section 07 84 00',
      targetType: 'section',
      value: '07 84 00',
    });

    const report = await getCoordinationReport(projectId, undefined);
    expect(ofType(report.findings, 'related_listed_not_cited')).toHaveLength(0);
    expect(ofType(report.findings, 'related_cited_not_listed')).toHaveLength(0);
    expect(report.summary.relatedListedNotCited).toBe(0);
    expect(report.summary.relatedCitedNotListed).toBe(0);
  });

  it('coordination: conduit body mentions firestopping but 07 84 00 not listed -> implied_related_section', async () => {
    const projectId = await newProject('coord-implied');
    await addDefaultProjectSource(projectId);
    const conduit = await newSpec('26 05 33', 'Raceways and Boxes for Electrical Systems');
    await newSpec('07 84 00', 'Firestopping');
    await addProjectSpec(projectId, conduit, 1);
    const paragraphId = await addParagraph(
      conduit,
      'Firestopping shall be provided where conduits penetrate rated assemblies.',
      1
    );

    const report = await getCoordinationReport(projectId, undefined);
    const findings = ofType(report.findings, 'implied_related_section');

    expect(findings).toEqual([
      {
        type: 'implied_related_section',
        sourceSpecId: conduit,
        sourceSpecSection: '26 05 33',
        sourceParagraphId: paragraphId,
        impliedSection: '07 84 00',
        impliedTitle: 'Firestopping',
        matchedKeyword: 'firestop',
        confidence: 0.72,
      },
    ]);
    expect(report.summary.impliedRelatedSection).toBe(1);
  });

  it('coordination: firestopping already listed in Related Sections -> no implied_related_section', async () => {
    const projectId = await newProject('coord-implied-listed');
    await addDefaultProjectSource(projectId);
    const conduit = await newSpec('26 05 33', 'Raceways and Boxes for Electrical Systems');
    await newSpec('07 84 00', 'Firestopping');
    await addProjectSpec(projectId, conduit, 1);
    const related = await newArticle(conduit, '1.1 RELATED SECTIONS', 1);
    await addClassifiedRef({
      specId: conduit,
      parentId: related,
      text: 'Section 07 84 00 Firestopping',
      targetType: 'section',
      value: '07 84 00',
    });
    await addParagraph(conduit, 'Provide firestopping at conduit penetrations.', 2);

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'implied_related_section')).toEqual([]);
    expect(report.summary.impliedRelatedSection).toBe(0);
  });

  it('coordination: explicit body citation yields related_cited_not_listed only, not implied_related_section', async () => {
    const projectId = await newProject('coord-implied-explicit');
    await addDefaultProjectSource(projectId);
    const conduit = await newSpec('26 05 33', 'Raceways and Boxes for Electrical Systems');
    await newSpec('07 84 00', 'Firestopping');
    await addProjectSpec(projectId, conduit, 1);
    const refParagraphId = await addClassifiedRef({
      specId: conduit,
      parentId: null,
      text: 'Section 07 84 00 Firestopping',
      targetType: 'section',
      value: '07 84 00',
    });

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'related_cited_not_listed')).toEqual([
      {
        type: 'related_cited_not_listed',
        sourceSpecId: conduit,
        sourceSpecSection: '26 05 33',
        sourceParagraphId: refParagraphId,
        section: '07 84 00',
      },
    ]);
    expect(ofType(report.findings, 'implied_related_section')).toEqual([]);
    expect(report.summary.impliedRelatedSection).toBe(0);
  });

  it('related_listed_not_cited carries the listing paragraph-level locator (#1 audit anchor)', async () => {
    const projectId = await newProject('coord-ref-anchor');
    await addDefaultProjectSource(projectId);
    const spec = await newSpec('08 11 13', 'Hollow Metal Doors');
    await addProjectSpec(projectId, spec, 1);
    const related = await newArticle(spec, '1.1 RELATED SECTIONS', 1);
    const listPid = await addClassifiedRef({
      specId: spec,
      parentId: related,
      text: 'Section 07 84 00 Firestopping',
      targetType: 'section',
      value: '07 84 00',
    });

    const report = await getCoordinationReport(projectId, undefined);
    const listed = ofType(report.findings, 'related_listed_not_cited');

    expect(listed).toHaveLength(1);
    expect(listed[0]?.section).toBe('07 84 00');
    expect(listed[0]?.sourceParagraphId).toBe(listPid);
  });

  it('coordination: generic body word general does not imply catalog General sections', async () => {
    const projectId = await newProject('coord-implied-general');
    await addDefaultProjectSource(projectId);
    const doors = await newSpec('08 11 13', 'Hollow Metal Doors');
    await newSpec('01 00 00', 'General Requirements');
    await addProjectSpec(projectId, doors, 1);
    await addParagraph(doors, 'Provide the work in general conformance with the Contract.', 1);

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'implied_related_section')).toEqual([]);
    expect(report.summary.impliedRelatedSection).toBe(0);
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

  it('emits present_not_required for every present spec when the required list is empty (ADR-043)', async () => {
    const projectId = await newProject('coord-empty');
    const specA = await newSpec('03 30 00', 'Concrete');
    await addProjectSpec(projectId, specA, 1);
    await addRef(specA, '09 91 00', 'see 09 91 00', null); // dangling still runs

    const report = await getCoordinationReport(projectId, undefined);

    // ADR-043: with no authored TOC, every present spec is trivially not in it.
    expect(ofType(report.findings, 'present_not_required').map((f) => f.section)).toEqual([
      '03 30 00',
    ]);
    expect(ofType(report.findings, 'required_not_present')).toHaveLength(0);
    expect(ofType(report.findings, 'dangling_ref')).toHaveLength(1);
    expect(report.notes).toEqual([
      'no required sections authored at this scope — every present section is reported as present-not-required',
      'umbrella call-out check covers all divisions in scope: 03',
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
