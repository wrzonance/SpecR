import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
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

async function patchJSON(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getLibraryId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM libraries WHERE name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`library ${name} missing — run migrations`);
  return r.rows[0].id;
}

let server: Server;
let baseUrl: string;
let testProjectId: string;
let specA: string;
let specB: string;
let companyId: string;
let ufgsId: string;
let companyLibId: string;
const apiProjects: string[] = [];

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
  [companyId, ufgsId] = await Promise.all([
    getLibraryId('Default Company Master'),
    getLibraryId('UFGS Reference'),
  ]);
  companyLibId = companyId;
  [specA, specB] = await Promise.all([
    insertSpec('03 30 00', 'Concrete'),
    insertSpec('09 91 00', 'Painting'),
  ]);
  testProjectId = await insertProject('Phase 1b Integration Test');
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`,
    [testProjectId, specA, specB]
  );
  // Fixture for availableFrom advisory test: specA (03 30 00) has an outgoing
  // ref to 09 91 00, which specB covers in the company master.
  const paraRes = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'article', 'See Section 09 91 00', 1) RETURNING id`,
    [specA]
  );
  const paraId = paraRes.rows[0]?.id;
  if (!paraId) throw new Error('failed to insert paragraph fixture');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', '09 91 00', 'See Section 09 91 00')`,
    [specA, paraId]
  );
});

afterAll(async () => {
  // Cleanup order matters — project_specs.spec_id FK is RESTRICT, so project_specs
  // rows must be removed before their referenced specs can be deleted.
  // Clone specs (project_id = apiProject) also carry parent_spec_id → specA/specB,
  // so clone specs must go before the master specs.
  if (apiProjects.length > 0) {
    await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [apiProjects]);
    await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [apiProjects]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [apiProjects]);
  }
  // testProjectId was inserted via raw SQL — deleting the project cascades its
  // project_specs rows (project_id FK is CASCADE), unblocking specA/specB deletion.
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

  it('returns 201 with ProjectSummary including sources', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Project', sourceLibraryIds: [companyId] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    const data = body['data'] as Record<string, unknown>;
    expect(typeof data['projectId']).toBe('string');
    createdId = data['projectId'] as string;
    const sources = data['sources'] as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.['libraryId']).toBe(companyId);
  });

  it('returns 422 for missing name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLibraryIds: [companyId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for empty name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', sourceLibraryIds: [companyId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when sourceLibraryIds is missing', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when reference-tier library is used as source', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', sourceLibraryIds: [ufgsId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for unknown library id', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        sourceLibraryIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /projects', () => {
  it('returns project ids, names, and section-number formats', async () => {
    const res = await fetch(`${baseUrl}/projects`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const projects = body['data'] as Array<Record<string, unknown>>;
    expect(projects).toEqual(
      expect.arrayContaining([
        {
          id: testProjectId,
          name: 'Phase 1b Integration Test',
          sectionNumberFormat: 'canonical',
        },
      ])
    );
  });
});

describe('GET /projects/:id', () => {
  it('returns 200 with toc containing both specs in position order', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(testProjectId);
    expect(data['sectionNumberFormat']).toBe('canonical');
    const toc = data['toc'] as Array<Record<string, unknown>>;
    expect(toc.length).toBe(2);
    expect(toc[0]?.['specId']).toBe(specA);
    expect(toc[1]?.['specId']).toBe(specB);
    // testProjectId was inserted via raw SQL (no sources) — field must still be present
    expect(data['sources']).toEqual([]);
  });

  it('returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /projects/:id', () => {
  it('renames the project and stores section-number format', async () => {
    const res = await patchJSON(`/projects/${testProjectId}`, {
      name: 'Phase 1b Integration Test Renamed',
      sectionNumberFormat: 'dots',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['name']).toBe('Phase 1b Integration Test Renamed');
    expect(data['sectionNumberFormat']).toBe('dots');

    const stored = await pool.query<{ name: string; section_number_format: string }>(
      'SELECT name, section_number_format FROM projects WHERE id = $1',
      [testProjectId]
    );
    expect(stored.rows[0]).toEqual({
      name: 'Phase 1b Integration Test Renamed',
      section_number_format: 'dots',
    });
  });

  it('rejects unknown section-number format', async () => {
    const res = await patchJSON(`/projects/${testProjectId}`, {
      sectionNumberFormat: 'slashes',
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for unknown project', async () => {
    const res = await patchJSON('/projects/00000000-0000-0000-0000-000000000000', {
      name: 'Missing',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/:id/specs (section-based copy-on-derive)', () => {
  let projectId: string;
  let cloneA: string;

  beforeAll(async () => {
    const res = await postJSON('/projects', {
      name: `Derive API ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const body = (await res.json()) as Record<string, unknown>;
    projectId = (body['data'] as Record<string, unknown>)['projectId'] as string;
    apiProjects.push(projectId);
  });

  it('adds a section: 201 with clone specId (not the master), source, position', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['specId']).not.toBe(specA);
    expect(d['section']).toBe('03 30 00');
    expect(d['position']).toBe(1);
    expect((d['source'] as Record<string, unknown>)['libraryId']).toBe(companyLibId);
    cloneA = d['specId'] as string;
  });

  it('normalizes display-variant section body before cloning into the project', async () => {
    const projectRes = await postJSON('/projects', {
      name: `Derive Display ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const projectBody = (await projectRes.json()) as Record<string, unknown>;
    const displayProjectId = (projectBody['data'] as Record<string, unknown>)[
      'projectId'
    ] as string;
    apiProjects.push(displayProjectId);

    const res = await postJSON(`/projects/${displayProjectId}/specs`, { section: '099100' });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['section']).toBe('09 91 00');
    const stored = await pool.query<{ section: string }>(
      'SELECT section FROM specs WHERE id = $1',
      [d['specId']]
    );
    expect(stored.rows[0]?.section).toBe('09 91 00');
  });

  it('409 on duplicate section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(409);
  });

  it('422 when no source holds the section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '99 99 99' });
    expect(res.status).toBe(422);
  });

  it('422 for malformed section body', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { specId: specA });
    expect(res.status).toBe(422);
  });

  it('404 for unknown project', async () => {
    const res = await postJSON(`/projects/00000000-0000-0000-0000-000000000000/specs`, {
      section: '03 30 00',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE clean clone returns 200 and deletes the copy, master survives', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const gone = await pool.query('SELECT 1 FROM specs WHERE id = $1', [cloneA]);
    expect(gone.rowCount).toBe(0);
    const master = await pool.query('SELECT 1 FROM specs WHERE id = $1', [specA]);
    expect(master.rowCount).toBe(1);
  });

  it('DELETE edited clone → 409; ?force=true → 200', async () => {
    const add = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    const d = ((await add.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    const cloneId = d['specId'] as string;
    await pool.query('UPDATE specs SET content_version = 2 WHERE id = $1', [cloneId]);
    const blocked = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneId}`, {
      method: 'DELETE',
    });
    expect(blocked.status).toBe(409);
    const forced = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneId}?force=true`, {
      method: 'DELETE',
    });
    expect(forced.status).toBe(200);
  });

  it('DELETE returns 404 when spec not owned by project', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${specA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:id/references/broken — availableFrom advisory', () => {
  it('broken ref lists the source libraries that hold the missing section', async () => {
    const created = await postJSON('/projects', {
      name: `Advisory ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const pid = (
      ((await created.json()) as Record<string, unknown>)['data'] as Record<string, unknown>
    )['projectId'] as string;
    apiProjects.push(pid);
    // Clone 03 30 00 — master specA has an outgoing ref to 09 91 00 (specB in the
    // company master). Since 09 91 00 is not yet in the project, the clone ref is
    // is_broken=true; availableFrom should name the company master library.
    await postJSON(`/projects/${pid}/specs`, { section: '03 30 00' });
    const res = await fetch(`${baseUrl}/projects/${pid}/references/broken`);
    expect(res.status).toBe(200);
    const refs = ((await res.json()) as Record<string, unknown>)['data'] as Array<
      Record<string, unknown>
    >;
    const ref = refs.find((r) => r['targetSpecSection'] === '09 91 00');
    expect(ref).toBeDefined();
    expect(ref?.['availableFrom']).toEqual([expect.objectContaining({ libraryId: companyLibId })]);
  });
});
