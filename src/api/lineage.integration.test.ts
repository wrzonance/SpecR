import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

const ORIGIN_META = {
  filename: 'lineage-api-fixture.sec',
  sha256: 'b'.repeat(64),
  loader: 'test:lineage-api-fixture',
};

let server: Server;
let baseUrl: string;
let companyLibId: string;
let clientLibId: string;
let projectId: string;
let rootSpecId: string;
let clientSpecId: string;
let projectSpecId: string;

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

async function seedLibrariesAndProject(): Promise<void> {
  const co = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', 'Lineage Co (api #97)') RETURNING id`
  );
  companyLibId = co.rows[0]?.id ?? '';
  const cl = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', 'Lineage Client (api #97)') RETURNING id`
  );
  clientLibId = cl.rows[0]?.id ?? '';
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('Lineage Project (api #97)') RETURNING id`
  );
  projectId = proj.rows[0]?.id ?? '';
}

async function seedSpecs(): Promise<void> {
  const root = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ('27 23 97', 'Root', 'docx', $1, 5, $2::jsonb) RETURNING id`,
    [companyLibId, JSON.stringify(ORIGIN_META)]
  );
  rootSpecId = root.rows[0]?.id ?? '';
  const client = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, parent_spec_id,
                        origin_version, content_version)
     VALUES ('27 23 97', 'Client copy', 'docx', $1, $2, 3, 2) RETURNING id`,
    [clientLibId, rootSpecId]
  );
  clientSpecId = client.rows[0]?.id ?? '';
  const projSpec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                        origin_version, content_version)
     VALUES ('27 23 97', 'Project copy', 'docx', $1, $2, 1, 4) RETURNING id`,
    [projectId, clientSpecId]
  );
  projectSpecId = projSpec.rows[0]?.id ?? '';
}

beforeAll(async () => {
  await startServer();
  await seedLibrariesAndProject();
  await seedSpecs();
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [
    [projectSpecId, clientSpecId, rootSpecId].filter(Boolean),
  ]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [
    [companyLibId, clientLibId],
  ]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('GET /specs/:id/lineage (integration)', () => {
  it('returns the full three-hop chain with behindBy and root originMeta', async () => {
    const res = await fetch(`${baseUrl}/specs/${projectSpecId}/lineage`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    const data = body['data'] as { chain: Record<string, unknown>[]; originMeta: unknown };
    expect(data.chain).toHaveLength(3);
    expect(data.chain[0]).toEqual({
      specId: projectSpecId,
      scope: 'project',
      name: 'Lineage Project (api #97)',
      contentVersion: 4,
      originVersion: 1,
      behindBy: 1,
    });
    expect(data.chain[1]?.['behindBy']).toBe(2);
    expect(data.chain[2]?.['specId']).toBe(rootSpecId);
    expect(data.chain[2]?.['behindBy']).toBeNull();
    expect(data.originMeta).toEqual(ORIGIN_META);
  });

  it('returns 404 for unknown UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000/lineage`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('spec not found');
  });
});
