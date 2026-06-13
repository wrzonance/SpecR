import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

const suffix = randomUUID().slice(0, 8);
const source = `api162_${suffix}`;
const projectIds: string[] = [];
const specIds: string[] = [];

let server: Server;
let baseUrl: string;
let projectA: string;
let projectB: string;
let sourceA: string;
let sourceB: string;
let targetA: string;

async function insertProject(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    'INSERT INTO projects (name) VALUES ($1) RETURNING id',
    [name]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('insertProject returned no id');
  projectIds.push(id);
  return id;
}

async function insertSpec(section: string, title: string, specSource: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, specSource]
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`insertSpec returned no id for ${section}`);
  specIds.push(id);
  return id;
}

async function addProjectSpec(projectId: string, specId: string, position: number): Promise<void> {
  await pool.query('INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,$3)', [
    projectId,
    specId,
    position,
  ]);
}

async function insertRef(sourceSpecId: string, text: string): Promise<void> {
  const paragraph = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'pr1', $2, 1) RETURNING id`,
    [sourceSpecId, text]
  );
  const paragraphId = paragraph.rows[0]?.id;
  if (paragraphId === undefined) throw new Error('insert paragraph returned no id');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, reference_text)
     VALUES ($1, $2, 'section', '09 91 00', $3, $4)`,
    [sourceSpecId, paragraphId, targetA, text]
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
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  projectA = await insertProject(`Reference API A ${suffix}`);
  projectB = await insertProject(`Reference API B ${suffix}`);
  sourceA = await insertSpec('03 30 00', 'Concrete API', `${source}_a`);
  sourceB = await insertSpec('05 12 00', 'Steel API', `${source}_b`);
  targetA = await insertSpec('09 91 00', 'Painting API', `${source}_t`);
  await addProjectSpec(projectA, sourceA, 1);
  await addProjectSpec(projectA, targetA, 2);
  await addProjectSpec(projectB, sourceB, 1);
  await insertRef(sourceA, 'API A cites painting');
  await insertRef(sourceB, 'API B cites painting');
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [specIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('GET /projects/:id/references/inbound', () => {
  it('returns in-project citing specs and excludes other projects', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${projectA}/references/inbound?section=09%2091%2000`
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(projectA);
    expect(data['section']).toBe('09 91 00');
    const refs = data['references'] as Array<Record<string, unknown>>;
    expect(refs.map((ref) => ref['sourceSpecId'])).toEqual([sourceA]);
    expect(refs.some((ref) => ref['sourceSpecId'] === sourceB)).toBe(false);
  });

  it('returns 400 on malformed section', async () => {
    const res = await fetch(
      `${baseUrl}/projects/${projectA}/references/inbound?section=9%2091%2000`
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown project', async () => {
    const res = await fetch(
      `${baseUrl}/projects/00000000-0000-0000-0000-000000000000/references/inbound?section=09%2091%2000`
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /projects/:id/specs/:specId/references', () => {
  it('returns outbound references for an in-project spec', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectA}/specs/${sourceA}/references`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(projectA);
    expect(data['specId']).toBe(sourceA);
    const refs = data['references'] as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(1);
    expect(refs[0]?.['targetSection']).toBe('09 91 00');
  });

  it('returns 404 when spec is not in the project', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectA}/specs/${sourceB}/references`);
    expect(res.status).toBe(404);
  });
});
