import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../index.js';
import { ProjectNotFoundError } from './derive.js';
import { getProjectRevitLinks } from './revit-links.js';
import { upsertMapping } from './revit.js';

// One project with three specs:
//   spec A (27 11 00): element E1 (2 params) + element E2 (1 param)
//   spec B (26 05 33): element E1 — cross-spec fan-out of the same instance
//   spec C (28 13 00): a paragraph but NO mappings — has no model backing
const suffix = randomUUID().slice(0, 8);
const E1 = `revit-instance-e1-${suffix}`;
const E2 = `revit-instance-e2-${suffix}`;

let projectId: string;
let specA: string;
let specB: string;
let specC: string;
const specIds: string[] = [];

async function insertSpec(section: string, title: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('spec insert returned no id');
  specIds.push(id);
  return id;
}

async function addToProject(specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
}

async function insertParagraph(specId: string, text: string, position: number): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', $2, $3) RETURNING id`,
    [specId, text, position]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('paragraph insert returned no id');
  return id;
}

beforeAll(async () => {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`revit-links-${suffix}`]
  );
  const pid = project.rows[0]?.id;
  if (pid === undefined) throw new Error('project insert returned no id');
  projectId = pid;

  specA = await insertSpec('27 11 00', 'Communications Rooms');
  specB = await insertSpec('26 05 33', 'Raceways');
  specC = await insertSpec('28 13 00', 'Access Control');
  await addToProject(specA, 1);
  await addToProject(specB, 2);
  await addToProject(specC, 3);

  const paraA = await insertParagraph(specA, 'Manufacturer placeholder', 1);
  const paraA2 = await insertParagraph(specA, 'Port count placeholder', 2);
  const paraB = await insertParagraph(specB, 'Conduit size placeholder', 1);
  await insertParagraph(specC, 'Unbacked paragraph', 1);

  // E1 → spec A (two params) and spec B (one param); E2 → spec A (one param).
  await upsertMapping({
    paragraphId: paraA,
    revitInstanceId: E1,
    revitParam: 'Manufacturer',
    transformType: 'replace',
  });
  await upsertMapping({
    paragraphId: paraA,
    revitInstanceId: E1,
    revitComponentRole: 'jack',
    revitParam: 'PortCount',
    transformType: 'placeholder',
  });
  await upsertMapping({
    paragraphId: paraA2,
    revitInstanceId: E2,
    revitParam: 'Manufacturer',
    transformType: 'replace',
  });
  await upsertMapping({
    paragraphId: paraB,
    revitInstanceId: E1,
    revitComponentRole: 'conduit',
    revitParam: 'TradeSize',
    transformType: 'replace',
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
});

describe('getProjectRevitLinks', () => {
  it('byElement returns element→sections (with cross-spec fan-out)', async () => {
    const inv = await getProjectRevitLinks(projectId);
    const e1 = inv.byElement.find((e) => e.revitInstanceId === E1);
    const e2 = inv.byElement.find((e) => e.revitInstanceId === E2);
    expect(e1?.specs.map((s) => s.section)).toEqual(['26 05 33', '27 11 00']);
    expect(e1?.linkCount).toBe(3); // 2 params on spec A + 1 on spec B
    expect(e2?.specs.map((s) => s.section)).toEqual(['27 11 00']);
    expect(e2?.linkCount).toBe(1);
  });

  it('bySpec returns section→elements, including specs with no model backing', async () => {
    const inv = await getProjectRevitLinks(projectId);
    const a = inv.bySpec.find((s) => s.specId === specA);
    const b = inv.bySpec.find((s) => s.specId === specB);
    const c = inv.bySpec.find((s) => s.specId === specC);
    expect(a?.elements).toEqual([E1, E2].sort((x, y) => x.localeCompare(y)));
    expect(b?.elements).toEqual([E1]);
    expect(c?.elements).toEqual([]); // present spec, zero elements
    expect(c?.linkCount).toBe(0);
  });

  it('summary exposes specsWithoutModelBacking and the element/spec/mapping counts', async () => {
    const { summary } = await getProjectRevitLinks(projectId);
    expect(summary.elementCount).toBe(2);
    expect(summary.specCount).toBe(3);
    expect(summary.mappedSpecCount).toBe(2);
    expect(summary.specsWithoutModelBacking).toBe(1); // spec C
    expect(summary.mappingCount).toBe(4);
  });

  it('unmappedElements is 0 — documented substrate limit (ADR-029/ADR-049)', async () => {
    // Every element that links to a project spec links to a *present* one, so the
    // mappings table cannot observe a model-placed-but-unmapped element. This
    // asserts the intentional 0 so a future model-element registry (#84) that
    // makes it non-zero trips this test and forces the contract to be revisited.
    const { summary } = await getProjectRevitLinks(projectId);
    expect(summary.unmappedElements).toBe(0);
  });

  it('filters the views by revitInstanceId but keeps the summary project-wide', async () => {
    const inv = await getProjectRevitLinks(projectId, { revitInstanceId: E1 });
    expect(inv.byElement.map((e) => e.revitInstanceId)).toEqual([E1]);
    // spec A now lists only E1; spec C still present but empty.
    expect(inv.bySpec.find((s) => s.specId === specA)?.elements).toEqual([E1]);
    expect(inv.bySpec.find((s) => s.specId === specC)?.elements).toEqual([]);
    expect(inv.summary.elementCount).toBe(2); // unchanged — computed project-wide
  });

  it('filters the views by specId', async () => {
    const inv = await getProjectRevitLinks(projectId, { specId: specA });
    expect(inv.bySpec.map((s) => s.specId)).toEqual([specA]);
    expect(inv.byElement.map((e) => e.revitInstanceId).sort((x, y) => x.localeCompare(y))).toEqual(
      [E1, E2].sort((x, y) => x.localeCompare(y))
    );
  });

  it('throws ProjectNotFoundError for an unknown project', async () => {
    await expect(
      getProjectRevitLinks('00000000-0000-0000-0000-000000000000')
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
