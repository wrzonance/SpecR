import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, upsertMapping } from '../db/index.js';
import { handleListRevitLinks } from './revit-links-tools.js';

const suffix = randomUUID().slice(0, 8);
const element = `revit-mcp-e1-${suffix}`;
let projectId: string;
let specId: string;
const specIds: string[] = [];

beforeAll(async () => {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`revit-links-mcp-${suffix}`]
  );
  projectId = project.rows[0]!.id;

  const backed = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 11 00', 'Communications Rooms', $1,
       (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING id`,
    [`revitmcp_${suffix}_a`]
  );
  specId = backed.rows[0]!.id;
  const unbacked = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('28 13 00', 'Access Control', $1,
       (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING id`,
    [`revitmcp_${suffix}_b`]
  );
  specIds.push(specId, unbacked.rows[0]!.id);
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [projectId, specId, unbacked.rows[0]!.id]
  );
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', 'Manufacturer placeholder', 1) RETURNING id`,
    [specId]
  );
  await upsertMapping({
    paragraphId: para.rows[0]!.id,
    revitInstanceId: element,
    revitParam: 'Manufacturer',
    transformType: 'replace',
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
});

describe('handleListRevitLinks (MCP)', () => {
  it('returns a JSON inventory with both pivots and the summary', async () => {
    const res = await handleListRevitLinks({ projectId });
    expect('isError' in res).toBe(false);
    const parsed = JSON.parse(res.content[0]?.text ?? '') as {
      projectId: string;
      byElement: { revitInstanceId: string }[];
      summary: { specsWithoutModelBacking: number; mappingCount: number };
    };
    expect(parsed.projectId).toBe(projectId);
    expect(parsed.byElement.map((e) => e.revitInstanceId)).toContain(element);
    expect(parsed.summary.specsWithoutModelBacking).toBe(1);
    expect(parsed.summary.mappingCount).toBe(1);
  });

  it('narrows the pivots with the specId filter', async () => {
    const res = await handleListRevitLinks({ projectId, specId });
    const parsed = JSON.parse(('content' in res && res.content[0]?.text) || '') as {
      bySpec: { specId: string }[];
    };
    expect(parsed.bySpec.map((s) => s.specId)).toEqual([specId]);
  });

  it('returns isError (never throws) for an unknown project', async () => {
    const res = await handleListRevitLinks({ projectId: '00000000-0000-4000-8000-000000000000' });
    expect('isError' in res && res.isError).toBe(true);
  });
});
