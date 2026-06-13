import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../db/index.js';
import { errorHandler } from './middleware/error.js';
import { router } from './router.js';

const ZERO = '00000000-0000-0000-0000-000000000000';
const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];

let server: Server;
let baseUrl: string;
let projectId: string;
let specA: string;
let specB: string;
let packageId: string;
let companyLibraryId: string;

async function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function data(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
}

async function insertSpec(section: string, title: string, source: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [section, title, source, companyLibraryId]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('insert spec failed');
  specIds.push(id);
  return id;
}

async function insertReference(sourceSpecId: string, target: string): Promise<void> {
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'article', $2, 1) RETURNING id`,
    [sourceSpecId, `See Section ${target}`]
  );
  const paraId = para.rows[0]?.id;
  if (!paraId) throw new Error('insert paragraph failed');
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', $3, $4)`,
    [sourceSpecId, paraId, target, `See Section ${target}`]
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
  baseUrl = `http://localhost:${typeof address === 'object' && address !== null ? address.port : 3000}`;
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  companyLibraryId = lib.rows[0]?.id ?? '';

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`coord-api-${suffix}`]
  );
  projectId = project.rows[0]?.id ?? '';
  projectIds.push(projectId);
  specA = await insertSpec('03 30 00', 'Concrete', `ca-${suffix}-a`);
  specB = await insertSpec('05 12 00', 'Steel', `ca-${suffix}-b`);
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position)
     VALUES ($1, $2, 1), ($1, $3, 2)`,
    [projectId, specA, specB]
  );
  await insertReference(specA, '07 21 00');
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position)
     VALUES ($1, 'API Package', 1) RETURNING id`,
    [projectId]
  );
  packageId = pkg.rows[0]?.id ?? '';
  await pool.query(`INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, 1)`, [
    packageId,
    specB,
  ]);
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM required_sections WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM spec_references WHERE source_spec_id = ANY($1)', [specIds]);
  await pool.query('DELETE FROM paragraphs WHERE spec_id = ANY($1)', [specIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [specIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('required sections REST', () => {
  it('PUT /projects/:id/required-sections sets ordered and GET lists', async () => {
    const put = await json('PUT', `/projects/${projectId}/required-sections`, {
      sections: [
        { section: '03 30 00', title: 'Concrete' },
        { section: '09 91 00', title: 'Painting' },
      ],
    });
    expect(put.status).toBe(200);
    const get = await json('GET', `/projects/${projectId}/required-sections`);
    expect(get.status).toBe(200);
    const sections = (await data(get))['sections'] as Array<Record<string, unknown>>;
    expect(sections.map((s) => [s['section'], s['position']])).toEqual([
      ['03 30 00', 1],
      ['09 91 00', 2],
    ]);
  });

  it('returns 422 for malformed section and duplicate body entries', async () => {
    const bad = await json('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30', title: 'Bad' }],
    });
    expect(bad.status).toBe(422);
    const dup = await json('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30 00' }, { section: '03 30 00' }],
    });
    expect(dup.status).toBe(422);
  });

  it('supports package required sections and returns 404 for unknown scopes', async () => {
    const put = await json('PUT', `/packages/${packageId}/required-sections`, {
      sections: [{ section: '09 91 00' }],
    });
    expect(put.status).toBe(200);
    const get = await json('GET', `/packages/${packageId}/required-sections`);
    const sections = (await data(get))['sections'] as Array<Record<string, unknown>>;
    expect(sections[0]?.['section']).toBe('09 91 00');
    expect(
      (await json('PUT', `/projects/${ZERO}/required-sections`, { sections: [] })).status
    ).toBe(404);
    expect(
      (await json('PUT', `/packages/${ZERO}/required-sections`, { sections: [] })).status
    ).toBe(404);
  });
});

describe('GET /projects/:id/coordination-report', () => {
  it('returns findings and summary', async () => {
    await json('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30 00' }, { section: '09 91 00' }],
    });
    const res = await json('GET', `/projects/${projectId}/coordination-report`);
    expect(res.status).toBe(200);
    const report = await data(res);
    expect(report['summary']).toEqual({
      presentNotRequired: 1,
      requiredNotPresent: 1,
      danglingRef: 1,
      total: 3,
    });
  });

  it('scopes by packageId and validates malformed packageId', async () => {
    const scoped = await json(
      'GET',
      `/projects/${projectId}/coordination-report?packageId=${packageId}`
    );
    expect(scoped.status).toBe(200);
    const report = await data(scoped);
    expect((report['summary'] as Record<string, unknown>)['total']).toBe(2);
    expect(
      (await json('GET', `/projects/${projectId}/coordination-report?packageId=bad`)).status
    ).toBe(422);
  });

  it('returns 404 for unknown project and package not in project', async () => {
    expect((await json('GET', `/projects/${ZERO}/coordination-report`)).status).toBe(404);
    expect(
      (await json('GET', `/projects/${projectId}/coordination-report?packageId=${ZERO}`)).status
    ).toBe(404);
  });
});
