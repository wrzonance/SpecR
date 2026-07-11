import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleGetReferenceGraph } from './reference-graph-handler.js';

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let projectId: string;
let libraryId: string;

function parse(res: Awaited<ReturnType<typeof handleGetReferenceGraph>>): { nodes: unknown[] } {
  if ('isError' in res && res.isError) throw new Error(res.content[0]?.text ?? 'error');
  return JSON.parse(res.content[0]!.text) as { nodes: unknown[] };
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RG MCP Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`RG MCP Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ('26 00 00','Electrical General',$1,$2) RETURNING id`,
    [`rgmcp_${suffix}`, libraryId]
  );
  specIds.push(s.rows[0]!.id);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1)`, [
    projectId,
    s.rows[0]!.id,
  ]);
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
});

describe('handleGetReferenceGraph', () => {
  it('returns a project graph', async () => {
    expect(parse(await handleGetReferenceGraph({ projectId })).nodes).toHaveLength(1);
  });
  it('returns a library graph', async () => {
    expect(parse(await handleGetReferenceGraph({ libraryId })).nodes).toHaveLength(1);
  });
  it('errors when neither or both scopes are given', async () => {
    expect('isError' in (await handleGetReferenceGraph({}))).toBe(true);
    expect('isError' in (await handleGetReferenceGraph({ projectId, libraryId }))).toBe(true);
  });
  it('errors on an unknown project', async () => {
    const res = await handleGetReferenceGraph({ projectId: randomUUID() });
    expect('isError' in res && res.isError).toBe(true);
  });
});
