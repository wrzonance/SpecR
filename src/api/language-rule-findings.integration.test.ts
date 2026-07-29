import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

// #411 / ADR-080 — mirrors coordination.integration.test.ts's project + spec
// fixture. The key invariant this suite pins: an unconfigured scope reports
// `configured: false` with zero findings on a 200, never a 404/500 —
// language linting is opt-in (ADR-019/ADR-080 D1).

let server: Server;
let baseUrl: string;
let libraryId: string;
let projectId: string;
let specId: string;
const suffix = randomUUID().slice(0, 8);

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const library = await createLibrary({ tier: 'client', name: `lang-findings-${suffix}` });
  libraryId = library.id;

  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('05 12 00', 'Steel', $1, $2)
     RETURNING id`,
    [`langapi_${suffix}`, libraryId]
  );
  specId = spec.rows[0]!.id;
  await pool.query(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'pr1', 'The Contractor shall furnish all labor.', 1)`,
    [specId]
  );

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`lang-findings-${suffix}`]
  );
  projectId = project.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await pool.query(`DELETE FROM language_rule_profiles WHERE library_id = $1`, [libraryId]);
  await pool.query(`DELETE FROM libraries WHERE id = $1`, [libraryId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface FindingsReportBody {
  readonly success: boolean;
  readonly data: {
    readonly configured: boolean;
    readonly findings: readonly unknown[];
    readonly summary: { readonly total: number };
    readonly notes: readonly string[];
  };
}

describe('GET /projects/:id/language-findings', () => {
  it('200 — configured:false with empty findings when nothing is configured anywhere', async () => {
    const res = await get(`/projects/${projectId}/language-findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FindingsReportBody;
    expect(body.data.configured).toBe(false);
    expect(body.data.findings).toEqual([]);
    expect(body.data.summary.total).toBe(0);
    expect(body.data.notes.length).toBeGreaterThan(0);
  });

  it('200 — reports a bannedTerm finding once the authoring library has a profile', async () => {
    const putRes = await put(`/libraries/${libraryId}/language-rules`, {
      rules: { bannedTerms: [{ term: 'shall', suggestion: 'will' }] },
    });
    expect(putRes.status).toBe(200);

    const res = await get(`/projects/${projectId}/language-findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as FindingsReportBody;
    expect(body.data.configured).toBe(true);
    expect(body.data.summary.total).toBeGreaterThan(0);
    expect(body.data.notes).toEqual([]);

    await pool.query(`DELETE FROM language_rule_profiles WHERE library_id = $1`, [libraryId]);
  });

  it('400 — malformed project id', async () => {
    const res = await get('/projects/not-a-uuid/language-findings');
    expect(res.status).toBe(400);
  });

  it('404 — unknown project', async () => {
    const res = await get('/projects/00000000-0000-4000-8000-000000000000/language-findings');
    expect(res.status).toBe(404);
  });

  it('400 — malformed packageId query param', async () => {
    const res = await get(`/projects/${projectId}/language-findings?packageId=not-a-uuid`);
    expect(res.status).toBe(400);
  });

  it('404 — unknown packageId', async () => {
    const res = await get(
      `/projects/${projectId}/language-findings?packageId=00000000-0000-4000-8000-000000000000`
    );
    expect(res.status).toBe(404);
  });
});
