import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, upsertMapping } from '../db/index.js';

let server: Server;
let baseUrl: string;
const suffix = randomUUID().slice(0, 8);
const element = `revit-api-e1-${suffix}`;
let projectId: string;
let specId: string;
const specIds: string[] = [];

interface Inventory {
  readonly projectId: string;
  readonly byElement: readonly { readonly revitInstanceId: string }[];
  readonly bySpec: readonly { readonly specId: string; readonly elements: readonly string[] }[];
  readonly summary: {
    readonly specsWithoutModelBacking: number;
    readonly unmappedElements: number;
    readonly mappingCount: number;
  };
}

async function seed(): Promise<void> {
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`revit-links-api-${suffix}`]
  );
  projectId = project.rows[0]?.id ?? '';
  if (!projectId) throw new Error('project insert returned no id');

  const backed = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 11 00', 'Communications Rooms', $1,
       (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING id`,
    [`revitapi_${suffix}_a`]
  );
  specId = backed.rows[0]?.id ?? '';
  const unbacked = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('28 13 00', 'Access Control', $1,
       (SELECT id FROM libraries WHERE name = 'Default Company Master')) RETURNING id`,
    [`revitapi_${suffix}_b`]
  );
  const unbackedId = unbacked.rows[0]?.id ?? '';
  specIds.push(specId, unbackedId);

  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [projectId, specId, unbackedId]
  );
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', 'Manufacturer placeholder', 1) RETURNING id`,
    [specId]
  );
  await upsertMapping({
    paragraphId: para.rows[0]?.id ?? '',
    revitInstanceId: element,
    revitParam: 'Manufacturer',
    transformType: 'replace',
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
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 3000}`;
  await seed();
});

afterAll(async () => {
  if (projectId) await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /projects/:id/revit-links', () => {
  it('returns the inventory in an ApiResponse envelope', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/revit-links`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Inventory };
    expect(body.success).toBe(true);
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.byElement.map((e) => e.revitInstanceId)).toContain(element);
    expect(body.data.summary.specsWithoutModelBacking).toBe(1);
    // Pinned per ADR-049: 0 by construction under the mappings-only substrate.
    // A non-zero value here means a model-element registry now exists — revisit ADR-049.
    expect(body.data.summary.unmappedElements).toBe(0);
    expect(body.data.summary.mappingCount).toBe(1);
    expect(body.data.bySpec.find((s) => s.specId === specId)?.elements).toEqual([element]);
  });

  it('applies the specId filter', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/revit-links?specId=${specId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Inventory };
    expect(body.data.bySpec.map((s) => s.specId)).toEqual([specId]);
  });

  it('validates the project id at the boundary (400)', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/revit-links`);
    expect(res.status).toBe(400);
  });

  it('rejects a malformed specId filter (400)', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/revit-links?specId=nope`);
    expect(res.status).toBe(400);
  });

  it('rejects an empty revitInstanceId filter (400, not a silent full inventory)', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/revit-links?revitInstanceId=`);
    expect(res.status).toBe(400);
  });

  it('rejects a repeated revitInstanceId filter (array) with 400', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${projectId}/revit-links?revitInstanceId=a&revitInstanceId=b`
    );
    expect(res.status).toBe(400);
  });

  it('rejects a repeated specId filter (array) with 400', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${projectId}/revit-links?specId=${specId}&specId=${specId}`
    );
    expect(res.status).toBe(400);
  });

  it('accepts a valid revitInstanceId filter and narrows the pivot', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${projectId}/revit-links?revitInstanceId=${element}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Inventory };
    expect(body.data.byElement.map((e) => e.revitInstanceId)).toEqual([element]);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/revit-links`);
    expect(res.status).toBe(404);
  });
});
