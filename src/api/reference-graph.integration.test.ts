import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';

const suffix = randomUUID().slice(0, 8);
const specIds: string[] = [];
let server: Server;
let baseUrl: string;
let projectId: string;
let libraryId: string;

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, `rgapi_${suffix}`, libraryId]
  );
  const id = r.rows[0]!.id;
  specIds.push(id);
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
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`RG API Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`RG API Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;
  const umbrella = await insertSpec('07 00 00', 'Thermal General');
  const sealants = await insertSpec('07 92 00', 'Joint Sealants');
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`,
    [projectId, umbrella, sealants]
  );
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1','x',1) RETURNING id`,
    [sealants]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text, is_broken)
     VALUES ($1,$2,'section','07 00 00',$3,'ref',false)`,
    [sealants, p.rows[0]!.id, umbrella]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe('GET /projects/:id/reference-graph', () => {
  it('returns a schema-valid graph', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/reference-graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { nodes: unknown[]; edges: { targetSpecId: string | null }[] };
    };
    await assertResponse('get', '/projects/{id}/reference-graph', 200, body);
    expect(body.data.nodes).toHaveLength(2);
    expect(body.data.edges.some((e) => e.targetSpecId !== null)).toBe(true);
  });

  it('adds anchors when includeAnchors=true', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/reference-graph?includeAnchors=true`);
    const body = (await res.json()) as { data: { edges: { anchors?: string[] }[] } };
    expect(body.data.edges[0]?.anchors?.length).toBeGreaterThan(0);
  });

  it('400 on a bad uuid and 404 on an unknown project', async () => {
    expect((await fetch(`${baseUrl}/projects/not-a-uuid/reference-graph`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/projects/${randomUUID()}/reference-graph`)).status).toBe(404);
  });
});

describe('GET /libraries/:id/reference-graph', () => {
  it('returns a schema-valid library graph and 404s an unknown library', async () => {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/reference-graph`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/libraries/{id}/reference-graph', 200, await res.json());
    expect((await fetch(`${baseUrl}/libraries/${randomUUID()}/reference-graph`)).status).toBe(404);
  });
});
