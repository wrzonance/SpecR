import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';
import { pool } from '../db/index.js';
import type { SourceFacts } from '../ast/index.js';

let server: Server;
let baseUrl: string;
let projectId: string;
let specId: string;
const suffix = randomUUID().slice(0, 8);

async function req(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  return { status: res.status, body: await res.json() };
}

let position = 0;
async function addParagraph(text: string, facts: SourceFacts): Promise<void> {
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, source_facts)
     VALUES ($1, $2, NULL, 'pr1', $3, $4, $5::jsonb)`,
    [randomUUID(), specId, text, ++position, JSON.stringify(facts)]
  );
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

  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`oc-api-${suffix}`]
  );
  projectId = p.rows[0]!.id;
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('07 92 00', 'Joint Sealants', $1, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [`ocapi_${suffix}`]
  );
  specId = spec.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  await addParagraph('Open.', {
    comments: [{ author: 'Alex', text: 'Coordinate.', anchor: [0, 4], closed: false }],
  });
  await addParagraph('Closed.', {
    comments: [{ author: 'Jane', text: 'Resolved Closed', anchor: [0, 4], closed: true }],
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('open-comments API (#262)', () => {
  it('GET /specs/:id/open-comments returns only the open comment and matches its schema', async () => {
    const r = await req('GET', `/specs/${specId}/open-comments`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/specs/{id}/open-comments', 200, r.body);
    const body = r.body as {
      success: boolean;
      data: { summary: { open: number; total: number }; openComments: { text: string }[] };
    };
    expect(body.data.summary).toEqual({ open: 1, total: 2 });
    expect(body.data.openComments.map((c) => c.text)).toEqual(['Coordinate.']);
  });

  it('GET /projects/:id/open-comments aggregates and matches its schema', async () => {
    const r = await req('GET', `/projects/${projectId}/open-comments`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/projects/{id}/open-comments', 200, r.body);
    const body = r.body as { data: { summary: { open: number } } };
    expect(body.data.summary.open).toBe(1);
  });

  it('400 on a malformed spec id', async () => {
    expect((await req('GET', `/specs/not-a-uuid/open-comments`)).status).toBe(400);
  });

  it('404 on an unknown spec', async () => {
    expect(
      (await req('GET', `/specs/00000000-0000-4000-8000-000000000000/open-comments`)).status
    ).toBe(404);
  });

  it('404 on an unknown project', async () => {
    expect(
      (await req('GET', `/projects/00000000-0000-4000-8000-000000000000/open-comments`)).status
    ).toBe(404);
  });
});
