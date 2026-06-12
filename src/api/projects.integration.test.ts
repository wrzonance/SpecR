import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    [section, title]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert spec ${section}`);
  return row.id;
}

async function insertProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const row = r.rows[0];
  if (!row) throw new Error('failed to insert project');
  return row.id;
}

async function postJSON(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertParagraph(specId: string, text: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'article', $2, 1) RETURNING id`,
    [specId, text]
  );
  const row = r.rows[0];
  if (!row) throw new Error('failed to insert paragraph');
  return row.id;
}

async function insertRef(
  sourceSpecId: string,
  sourceParaId: string,
  section: string,
  targetSpecId: string,
  text: string
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text)
     VALUES ($1, $2, 'section', $3, $4, $5) RETURNING id`,
    [sourceSpecId, sourceParaId, section, targetSpecId, text]
  );
  const row = r.rows[0];
  if (!row) throw new Error('failed to insert ref');
  return row.id;
}

let server: Server;
let baseUrl: string;
let testProjectId: string;
let specA: string;
let specB: string;
let refId: string;
let reverseRefId: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
  [specA, specB] = await Promise.all([
    insertSpec('03 30 00', 'Concrete'),
    insertSpec('09 91 00', 'Painting'),
  ]);
  testProjectId = await insertProject('Phase 1b Integration Test');
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`,
    [testProjectId, specA, specB]
  );
  const [paraAId, paraBId] = await Promise.all([
    insertParagraph(specA, 'See Section 09 91 00'),
    insertParagraph(specB, 'See Section 03 30 00'),
  ]);
  [refId, reverseRefId] = await Promise.all([
    insertRef(specA, paraAId, '09 91 00', specB, 'See Section 09 91 00'),
    insertRef(specB, paraBId, '03 30 00', specA, 'See Section 03 30 00'),
  ]);
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specA, specB]]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /projects', () => {
  let createdId: string;
  afterAll(async () => {
    if (createdId) await pool.query('DELETE FROM projects WHERE id = $1', [createdId]);
  });

  it('returns 201 with ProjectSummary', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Project' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    const data = body['data'] as Record<string, unknown>;
    expect(typeof data['projectId']).toBe('string');
    createdId = data['projectId'] as string;
  });

  it('returns 422 for missing name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for empty name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /projects/:id', () => {
  it('returns 200 with toc containing both specs in position order', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(testProjectId);
    const toc = data['toc'] as Array<Record<string, unknown>>;
    expect(toc.length).toBe(2);
    expect(toc[0]?.['specId']).toBe(specA);
    expect(toc[1]?.['specId']).toBe(specB);
  });

  it('returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/specs (TOC add)', () => {
  let addProjectId: string;
  beforeAll(async () => {
    addProjectId = await insertProject('TOC Add Test');
  });
  afterAll(async () => {
    await pool.query('DELETE FROM projects WHERE id = $1', [addProjectId]);
  });

  it('adds specA at position 1', async () => {
    const res = await postJSON(`/projects/${addProjectId}/specs`, { specId: specA });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['position']).toBe(1);
  });

  it('adds specB at position 2', async () => {
    const res = await postJSON(`/projects/${addProjectId}/specs`, { specId: specB });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['position']).toBe(2);
  });

  it('returns 409 on duplicate spec', async () => {
    const res = await postJSON(`/projects/${addProjectId}/specs`, { specId: specA });
    expect(res.status).toBe(409);
  });

  it('returns 422 for invalid specId', async () => {
    const res = await postJSON(`/projects/${addProjectId}/specs`, { specId: 'not-a-uuid' });
    expect(res.status).toBe(422);
  });

  it('GET toc shows both specs in position order', async () => {
    const res = await fetch(`${baseUrl}/projects/${addProjectId}`);
    const toc = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    const entries = toc['toc'] as Array<Record<string, unknown>>;
    expect(entries[0]?.['specId']).toBe(specA);
    expect(entries[1]?.['specId']).toBe(specB);
  });
});

describe('DELETE from TOC (broken ref cascade)', () => {
  it('ref starts non-broken', async () => {
    const row = await pool.query<{ is_broken: boolean }>(
      'SELECT is_broken FROM spec_references WHERE id = $1',
      [refId]
    );
    expect(row.rows[0]?.is_broken).toBe(false);
  });

  it('DELETE removes spec from TOC and marks ref broken', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}/specs/${specB}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const row = await pool.query<{ is_broken: boolean }>(
      'SELECT is_broken FROM spec_references WHERE id = $1',
      [refId]
    );
    expect(row.rows[0]?.is_broken).toBe(true);
  });

  it("removed spec's own outgoing refs are not marked broken", async () => {
    const row = await pool.query<{ is_broken: boolean }>(
      'SELECT is_broken FROM spec_references WHERE id = $1',
      [reverseRefId]
    );
    expect(row.rows[0]?.is_broken).toBe(false);
  });

  it('spec row still exists in library after TOC removal', async () => {
    const res = await pool.query<{ id: string }>('SELECT id FROM specs WHERE id = $1', [specB]);
    expect(res.rows[0]?.id).toBe(specB);
  });

  it('GET broken refs surfaces broken ref scoped to project', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}/references/broken`);
    expect(res.status).toBe(200);
    const refs = ((await res.json()) as Record<string, unknown>)['data'] as Array<
      Record<string, unknown>
    >;
    expect(refs.length).toBe(1);
    expect(refs[0]?.['refId']).toBe(refId);
    expect(refs[0]?.['targetSpecSection']).toBe('09 91 00');
  });
});

describe('re-add to TOC (ref resolution)', () => {
  it('re-adding specB clears is_broken and resolves target_spec_id', async () => {
    const addRes = await postJSON(`/projects/${testProjectId}/specs`, { specId: specB });
    expect(addRes.status).toBe(201);
    const addData = ((await addRes.json()) as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    expect(typeof addData['position']).toBe('number');
    const row = await pool.query<{ is_broken: boolean; target_spec_id: string }>(
      'SELECT is_broken, target_spec_id FROM spec_references WHERE id = $1',
      [refId]
    );
    expect(row.rows[0]?.is_broken).toBe(false);
    expect(row.rows[0]?.target_spec_id).toBe(specB);
  });

  it('GET broken refs empty after re-add', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}/references/broken`);
    const refs = ((await res.json()) as Record<string, unknown>)['data'] as Array<
      Record<string, unknown>
    >;
    expect(refs.find((r) => r['refId'] === refId)).toBeUndefined();
  });
});

describe('DELETE /projects/:id/specs/:specId (not found)', () => {
  it('returns 404 when spec not in project', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${testProjectId}/specs/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE' }
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['error']).toBe('spec not in project');
  });
});
