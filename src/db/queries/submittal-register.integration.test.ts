import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, createAssociation } from '../index.js';
import { getCoordinationReport, type Finding } from './coordination.js';
import { getSubmittalRegister } from './submittal-register.js';

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let specCounter = 0;

async function newProject(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`submittals-${name}-${suffix}`]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('newProject returned no id');
  projectIds.push(id);
  return id;
}

async function newSpec(section: string, title: string): Promise<string> {
  const source = `sr_${suffix}_${++specCounter}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, source]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('newSpec returned no id');
  specIds.push(id);
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}

async function paragraph(
  specId: string,
  parentId: string | null,
  type: string,
  text: string,
  position: number
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [specId, parentId, type, text, position]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('paragraph returned no id');
  return id;
}

async function addSubmittalsArticle(specId: string, items: readonly string[]): Promise<void> {
  const part = await paragraph(specId, null, 'part', 'PART 1 - GENERAL', 1);
  const article = await paragraph(specId, part, 'article', 'SUBMITTALS', 1);
  await Promise.all(items.map((item, index) => paragraph(specId, article, 'pr1', item, index + 1)));
}

async function addProducts(
  specId: string,
  productNames: readonly string[]
): Promise<readonly string[]> {
  const part = await paragraph(specId, null, 'part', 'PART 2 - PRODUCTS', 2);
  return Promise.all(
    productNames.map((name, index) => paragraph(specId, part, 'article', name, index + 1))
  );
}

async function addExecutionMention(specId: string): Promise<void> {
  const part = await paragraph(specId, null, 'part', 'PART 3 - EXECUTION', 3);
  const article = await paragraph(specId, part, 'article', 'INSTALLATION', 1);
  await paragraph(specId, article, 'pr1', 'Install EMT conduit and fittings', 1);
}

function ofType<T extends Finding['type']>(
  findings: readonly Finding[],
  type: T
): Extract<Finding, { type: T }>[] {
  return findings.filter((finding): finding is Extract<Finding, { type: T }> => {
    return finding.type === type;
  });
}

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
});

describe('getSubmittalRegister', () => {
  it('submittals: selected project specs aggregate products, dedupe identical products, and surface datasheets', async () => {
    const projectId = await newProject('register');
    const specA = await newSpec('27 11 00', 'Communications Rooms');
    const specB = await newSpec('27 13 00', 'Communications Backbone');
    await addProjectSpec(projectId, specA, 1);
    await addProjectSpec(projectId, specB, 2);
    await addSubmittalsArticle(specA, ['SD-03 Product Data', 'SD-02 Shop Drawings']);
    await addSubmittalsArticle(specB, ['Product Data']);
    const [patchA, rack] = await addProducts(specA, ['PATCH PANELS', 'EQUIPMENT RACKS']);
    const [patchB] = await addProducts(specB, ['PATCH PANELS']);
    if (patchA === undefined || patchB === undefined || rack === undefined) {
      throw new Error('expected product ids');
    }
    await createAssociation(patchA, {
      label: 'Patch panel datasheet',
      url: 'https://a.test/p.pdf',
    });
    await createAssociation(patchB, { label: 'Patch panel B', url: 'https://b.test/p.pdf' });
    await createAssociation(rack, { label: 'Rack datasheet', url: 'https://a.test/r.pdf' });

    const register = await getSubmittalRegister(projectId, [specA, specB]);

    expect(register.projectId).toBe(projectId);
    expect(register.specIds).toEqual([specA, specB]);
    expect(register.rows.map((row) => row.productName)).toEqual([
      'Patch Panels',
      'Equipment Racks',
    ]);
    const patch = register.rows.find((row) => row.productName === 'Patch Panels');
    expect(patch?.sources.map((source) => source.section)).toEqual(['27 11 00', '27 13 00']);
    expect(patch?.requiredSubmittalTypes).toEqual(['Product Data', 'Shop Drawings']);
    expect(patch?.datasheets.map((sheet) => sheet.label)).toEqual([
      'Patch panel datasheet',
      'Patch panel B',
    ]);
  });

  it('submittals: rejects a selected spec that is not in the project', async () => {
    const projectId = await newProject('outside');
    const inside = await newSpec('07 92 00', 'Joint Sealants');
    const outside = await newSpec('08 71 00', 'Door Hardware');
    await addProjectSpec(projectId, inside, 1);

    await expect(getSubmittalRegister(projectId, [inside, outside])).rejects.toThrow(
      /not in project/
    );
  });
});

describe('getCoordinationReport submittal findings', () => {
  it('coordination: product-driven submittal findings join the existing report union', async () => {
    const projectId = await newProject('coord');
    const missingSheet = await newSpec('07 92 00', 'Joint Sealants');
    const noTypes = await newSpec('08 71 00', 'Door Hardware');
    const noProducts = await newSpec('09 90 00', 'Painting');
    await addProjectSpec(projectId, missingSheet, 1);
    await addProjectSpec(projectId, noTypes, 2);
    await addProjectSpec(projectId, noProducts, 3);
    await addSubmittalsArticle(missingSheet, ['Product Data']);
    await addProducts(missingSheet, ['JOINT SEALANTS']);
    await addSubmittalsArticle(noTypes, []);
    const [closers] = await addProducts(noTypes, ['DOOR CLOSERS']);
    if (closers === undefined) throw new Error('expected closer id');
    await createAssociation(closers, { label: 'Closer datasheet', url: 'https://d.test/c.pdf' });
    await addSubmittalsArticle(noProducts, ['Samples']);
    await addProducts(noProducts, []);
    await addExecutionMention(noProducts);

    const report = await getCoordinationReport(projectId, undefined);

    expect(ofType(report.findings, 'product_missing_datasheet').map((f) => f.productName)).toEqual([
      'Joint Sealants',
    ]);
    expect(
      ofType(report.findings, 'product_without_submittal_type').map((f) => f.productName)
    ).toEqual(['Door Closers']);
    expect(
      ofType(report.findings, 'submittal_type_without_product').map((f) => f.submittalType)
    ).toEqual(['Samples']);
    expect(report.summary.productMissingDatasheet).toBe(1);
    expect(report.summary.productWithoutSubmittalType).toBe(1);
    expect(report.summary.submittalTypeWithoutProduct).toBe(1);
  });
});
