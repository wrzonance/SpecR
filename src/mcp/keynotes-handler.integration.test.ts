import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import { handleGetProjectKeynotes } from './keynotes-handler.js';

const suffix = randomUUID().slice(0, 8);
const libIds: string[] = [];
const projectIds: string[] = [];
let projectId: string;

interface Keynote {
  readonly code: string;
  readonly description: string;
  readonly parentCode: string | null;
  readonly targetSection: string;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join('');
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [`Keynote MCP Co ${suffix}`]
  );
  const libId = lib.rows[0]?.id;
  if (!libId) throw new Error('library insert failed');
  libIds.push(libId);

  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`keynote-mcp-${suffix}`]
  );
  projectId = proj.rows[0]?.id ?? '';
  if (!projectId) throw new Error('project insert failed');
  projectIds.push(projectId);

  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, libId]
  );
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ('88 77 01', 'Ceilings', 'arcat', $1) RETURNING id`,
    [projectId]
  );
  const specId = spec.rows[0]?.id;
  if (!specId) throw new Error('spec insert failed');
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);

  await pool.query(
    `INSERT INTO keynotes (library_id, code, parent_code, description, target_section)
     VALUES ($1, 'A-CEIL', NULL, 'Acoustical ceiling', '88 77 01'),
            ($1, 'A-CEIL-1', 'A-CEIL', 'Suspended panel', '88 77 01'),
            ($1, 'Z-PAINT', NULL, 'Paint not in manual', '88 99 00')`,
    [libId]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM keynotes WHERE library_id = ANY($1::uuid[])`, [libIds]);
  await pool.query(`DELETE FROM project_specs WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM project_sources WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [libIds]);
});

describe('handleGetProjectKeynotes — MCP get_project_keynotes', () => {
  it('keynotes: returns the TOC-filtered rows as structured JSON, ordered, hierarchy preserved', async () => {
    const result = await handleGetProjectKeynotes({ projectId });
    expect('isError' in result).toBe(false);
    const rows = JSON.parse(textOf(result)) as Keynote[];
    expect(rows.map((k) => k.code)).toEqual(['A-CEIL', 'A-CEIL-1']); // Z-PAINT filtered out
    expect(rows.find((k) => k.code === 'A-CEIL-1')).toMatchObject({
      parentCode: 'A-CEIL',
      description: 'Suspended panel',
      targetSection: '88 77 01',
    });
  });

  it('keynotes: an unknown project is an isError result, not a silently-empty list', async () => {
    const result = await handleGetProjectKeynotes({ projectId: randomUUID() });
    expect('isError' in result && result.isError).toBe(true);
  });
});
