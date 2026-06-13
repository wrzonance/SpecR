import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let libraryId: string;
let otherLibraryId: string;
let projectId: string;
let candidateSpecId: string;
let firstSpecId: string;
let wrongScopeSpecId: string;
let projectExactSpecId: string;

async function startServer(): Promise<void> {
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
}

async function insertLibrary(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [name]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertLibrary failed');
  return row.id;
}

async function insertSpec(
  owner: { readonly libraryId?: string; readonly projectId?: string },
  section: string,
  title: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, project_id)
     VALUES ($1, $2, 'unknown', $3, $4) RETURNING id`,
    [section, title, owner.libraryId ?? null, owner.projectId ?? null]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertSpec failed');
  return row.id;
}

async function putJSON(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await startServer();
  const suffix = randomUUID().slice(0, 8);
  libraryId = await insertLibrary(`Division API ${suffix}`);
  otherLibraryId = await insertLibrary(`Division API Other ${suffix}`);
  firstSpecId = await insertSpec({ libraryId }, '27 05 26', 'Grounding and Bonding');
  candidateSpecId = await insertSpec(
    { libraryId },
    '27 10 00',
    'Common Work Results for Communications'
  );
  wrongScopeSpecId = await insertSpec({ libraryId: otherLibraryId }, '27 00 00', 'Other General');
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`Division API Project ${suffix}`]
  );
  projectId = project.rows[0]?.id ?? '';
  projectExactSpecId = await insertSpec(
    { projectId },
    '27 00 00',
    'Project Communications General'
  );
});

afterAll(async () => {
  await pool.query(
    'DELETE FROM division_general_specs WHERE library_id = ANY($1::uuid[]) OR project_id = $2',
    [[libraryId, otherLibraryId].filter(Boolean), projectId]
  );
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1::uuid[])', [
    [libraryId, otherLibraryId].filter(Boolean),
  ]);
  await pool.query('DELETE FROM specs WHERE project_id = $1', [projectId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [libraryId, otherLibraryId].filter(Boolean),
  ]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('division general REST API', () => {
  it('GET library scope returns missing with advisory candidates when NN 00 00 is absent', async () => {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/divisions/27/general-spec`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['status']).toBe('missing');
    expect(data['expectedSection']).toBe('27 00 00');
    expect(data['generalSpec']).toBeNull();
    expect(String(data['message'])).toContain('No 27 00 00 spec exists');
    const candidates = data['candidates'] as Array<Record<string, unknown>>;
    expect(candidates[0]).toEqual(expect.objectContaining({ specId: candidateSpecId }));
    expect(candidates[1]).toEqual(expect.objectContaining({ specId: firstSpecId }));
  });

  it('PUT library scope manually assigns a division general spec', async () => {
    const res = await putJSON(`/libraries/${libraryId}/divisions/27/general-spec`, {
      generalSpecId: candidateSpecId,
      notes: 'Telecom consultant issues 27 00 00 separately.',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['status']).toBe('resolved');
    expect(data['detectionMethod']).toBe('manual');
    expect(data['generalSpec']).toEqual(
      expect.objectContaining({ specId: candidateSpecId, section: '27 10 00' })
    );
  });

  it('PUT library scope can mark a division not applicable', async () => {
    const res = await putJSON(`/libraries/${libraryId}/divisions/27/general-spec`, {
      status: 'not_applicable',
      notes: 'Issued by owner.',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['status']).toBe('not_applicable');
    expect(data['generalSpec']).toBeNull();
    expect(data['notes']).toBe('Issued by owner.');
  });

  it('PUT rejects a spec outside the owner scope', async () => {
    const res = await putJSON(`/libraries/${libraryId}/divisions/27/general-spec`, {
      generalSpecId: wrongScopeSpecId,
    });
    expect(res.status).toBe(422);
  });

  it('PUT validates ambiguous or empty body at the API boundary', async () => {
    const res = await putJSON(`/libraries/${libraryId}/divisions/27/general-spec`, {});
    expect(res.status).toBe(422);
  });

  it('GET project scope auto-resolves exact NN 00 00 independently', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/divisions/27/general-spec`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['scope']).toBe('project');
    expect(data['status']).toBe('resolved');
    expect(data['detectionMethod']).toBe('exact_section');
    expect(data['generalSpec']).toEqual(expect.objectContaining({ specId: projectExactSpecId }));
  });

  it('GET returns 400 for malformed division and 404 for unknown owner', async () => {
    const badDivision = await fetch(`${baseUrl}/libraries/${libraryId}/divisions/2/general-spec`);
    expect(badDivision.status).toBe(400);
    const missing = await fetch(
      `${baseUrl}/libraries/00000000-0000-0000-0000-000000000000/divisions/27/general-spec`
    );
    expect(missing.status).toBe(404);
  });
});
