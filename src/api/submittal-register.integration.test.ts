import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createAssociation } from '../db/index.js';

let server: Server;
let baseUrl: string;
const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let specCounter = 0;

async function post(
  path: string,
  body: unknown
): Promise<{ readonly status: number; readonly body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function setupSpec(): Promise<{ readonly projectId: string; readonly specId: string }> {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`submittal-api-${suffix}`]
  );
  const projectId = project.rows[0]?.id;
  if (projectId === undefined) throw new Error('project insert returned no id');
  projectIds.push(projectId);
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 11 00', 'Communications Rooms', $1,
       (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [`srapi_${suffix}_${++specCounter}`]
  );
  const specId = spec.rows[0]?.id;
  if (specId === undefined) throw new Error('spec insert returned no id');
  specIds.push(specId);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  return { projectId, specId };
}

async function addTree(specId: string): Promise<void> {
  const p1 = await paragraph(specId, null, 'part', 'PART 1 - GENERAL', 1);
  const sub = await paragraph(specId, p1, 'article', 'SUBMITTALS', 1);
  await paragraph(specId, sub, 'pr1', 'Product Data', 1);
  const p2 = await paragraph(specId, null, 'part', 'PART 2 - PRODUCTS', 2);
  const product = await paragraph(specId, p2, 'article', 'PATCH PANELS', 1);
  await createAssociation(product, {
    label: 'Patch panel datasheet',
    url: 'https://api.test/p.pdf',
  });
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
  if (id === undefined) throw new Error('paragraph insert returned no id');
  return id;
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
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 3000}`;
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [specIds]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('submittal-register API', () => {
  it('POST returns the selected-spec product register in an ApiResponse envelope', async () => {
    const { projectId, specId } = await setupSpec();
    await addTree(specId);

    const response = await post(`/projects/${projectId}/submittal-register`, { specIds: [specId] });

    expect(response.status).toBe(200);
    const body = response.body as {
      success: boolean;
      data: { rows: { productName: string; datasheetStatus: string; datasheets: unknown[] }[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.rows[0]?.productName).toBe('Patch Panels');
    expect(body.data.rows[0]?.datasheetStatus).toBe('present');
    expect(body.data.rows[0]?.datasheets).toHaveLength(1);
  });

  it('POST validates ids at the boundary', async () => {
    expect((await post('/projects/not-a-uuid/submittal-register', { specIds: [] })).status).toBe(
      400
    );
    const { projectId } = await setupSpec();
    expect(
      (await post(`/projects/${projectId}/submittal-register`, { specIds: ['bad'] })).status
    ).toBe(422);
  });
});
