import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

const ZERO = '00000000-0000-0000-0000-000000000000';

let server: Server;
let baseUrl: string;
let companyId: string;
const projectIds: string[] = [];
const masterIds: string[] = [];
let p1: string; // project under test
let steel1: string; // P1 clone of 05 12 00
let hvac1: string; // P1 clone of 23 09 23
let steel2: string; // P2 clone of 05 12 00

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

async function insertMaster(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, companyId]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert master ${section}`);
  masterIds.push(row.id);
  return row.id;
}

async function createProjectWithSections(
  name: string,
  sections: readonly string[]
): Promise<{ projectId: string; specIds: string[] }> {
  const created = await json('POST', '/projects', { name, sourceLibraryIds: [companyId] });
  const projectId = (await data(created))['projectId'] as string;
  projectIds.push(projectId);
  const specIds: string[] = [];
  for (const section of sections) {
    const added = await json('POST', `/projects/${projectId}/specs`, { section });
    specIds.push((await data(added))['specId'] as string);
  }
  return { projectId, specIds };
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
  // Isolated, uniquely-named company library — NOT the shared, name-looked-up
  // 'Default Company Master'. Inserting fixture masters into the shared
  // library is ambient-state dependent: resolveSection's
  // `ORDER BY ps.priority, s.created_at, s.id` tie-break silently prefers an
  // older leftover row over this file's fresh fixture (same class as #522/#631).
  const lib = await createLibrary({
    tier: 'company',
    name: `Packages API Master ${randomUUID()}`,
  });
  companyId = lib.id;
  await insertMaster('05 12 00', 'Structural Steel Framing');
  await insertMaster('23 09 23', 'Direct Digital Control');
  const proj1 = await createProjectWithSections(`Pkg API P1 ${Date.now()}`, [
    '05 12 00',
    '23 09 23',
  ]);
  p1 = proj1.projectId;
  [steel1, hvac1] = proj1.specIds as [string, string];
  const proj2 = await createProjectWithSections(`Pkg API P2 ${Date.now()}`, ['05 12 00']);
  [steel2] = proj2.specIds as [string];
});

afterAll(async () => {
  // packages cascade their package_specs; clones must be unhooked before specs delete
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [masterIds]);
  // project_sources.library_id is FK-RESTRICT (project_id is CASCADE, so the
  // project deletes above already took most of these); clear any remainder
  // before dropping the isolated fixture library.
  if (companyId) {
    await pool.query('DELETE FROM project_sources WHERE library_id = $1', [companyId]);
    await pool.query('DELETE FROM libraries WHERE id = $1', [companyId]);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /projects/:id/packages', () => {
  it('creates packages with auto-incrementing position', async () => {
    const res1 = await json('POST', `/projects/${p1}/packages`, { name: 'Early Steel Release' });
    expect(res1.status).toBe(201);
    const d1 = await data(res1);
    expect(typeof d1['packageId']).toBe('string');
    expect(d1['name']).toBe('Early Steel Release');
    expect(d1['position']).toBe(1);
    const res2 = await json('POST', `/projects/${p1}/packages`, { name: '100% CD Set' });
    expect((await data(res2))['position']).toBe(2);
  });

  it('409 on duplicate name within the project', async () => {
    const res = await json('POST', `/projects/${p1}/packages`, { name: 'Early Steel Release' });
    expect(res.status).toBe(409);
  });

  it('404 for unknown project', async () => {
    const res = await json('POST', `/projects/${ZERO}/packages`, { name: 'X' });
    expect(res.status).toBe(404);
  });

  it('422 for empty name', async () => {
    const res = await json('POST', `/projects/${p1}/packages`, { name: '' });
    expect(res.status).toBe(422);
  });

  it('400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await json('POST', '/projects/not-a-uuid/packages', { name: 'X' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });
});

describe('PUT /packages/:id/specs — ordered membership', () => {
  let early: string;
  let cdSet: string;

  beforeAll(async () => {
    const list = await json('GET', `/projects/${p1}/packages`);
    const pkgs = (await data(list)) as unknown as Array<Record<string, unknown>>;
    early = pkgs.find((p) => p['name'] === 'Early Steel Release')?.['packageId'] as string;
    cdSet = pkgs.find((p) => p['name'] === '100% CD Set')?.['packageId'] as string;
  });

  it('sets ordered membership; a spec may belong to two packages', async () => {
    const res1 = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1] });
    expect(res1.status).toBe(200);
    const res2 = await json('PUT', `/packages/${cdSet}/specs`, { specIds: [hvac1, steel1] });
    expect(res2.status).toBe(200);
    const d2 = await data(res2);
    const specs = d2['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => [s['specId'], s['position']])).toEqual([
      [hvac1, 1],
      [steel1, 2],
    ]);
  });

  it('replacement reorders: PUT again with reversed order', async () => {
    const res = await json('PUT', `/packages/${cdSet}/specs`, { specIds: [steel1, hvac1] });
    const specs = (await data(res))['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => s['specId'])).toEqual([steel1, hvac1]);
  });

  it("422 when a spec belongs to another project's TOC", async () => {
    const res = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1, steel2] });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toContain(steel2);
  });

  it('empty array clears the package', async () => {
    const before = await json('PUT', `/packages/${early}/specs`, { specIds: [steel1] });
    expect(before.status).toBe(200);
    const res = await json('PUT', `/packages/${early}/specs`, { specIds: [] });
    expect(res.status).toBe(200);
    expect((await data(res))['specs']).toEqual([]);
  });

  it('404 for unknown package', async () => {
    const res = await json('PUT', `/packages/${ZERO}/specs`, { specIds: [steel1] });
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) package id (#568)', async () => {
    const res = await json('PUT', '/packages/not-a-uuid/specs', { specIds: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid package id' });
  });
});

describe('GET /projects/:id/packages', () => {
  it('lists packages in position order with ordered membership', async () => {
    const res = await json('GET', `/projects/${p1}/packages`);
    expect(res.status).toBe(200);
    const pkgs = (await data(res)) as unknown as Array<Record<string, unknown>>;
    expect(pkgs.map((p) => p['name'])).toEqual(['Early Steel Release', '100% CD Set']);
    const cd = pkgs[1] as Record<string, unknown>;
    const specs = cd['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => s['specId'])).toEqual([steel1, hvac1]);
    expect(specs[0]?.['section']).toBe('05 12 00');
  });

  it('404 for unknown project', async () => {
    const res = await json('GET', `/projects/${ZERO}/packages`);
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await json('GET', '/projects/not-a-uuid/packages');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });
});

describe('package_specs RESTRICT interaction (ADR-015 D4)', () => {
  it('DELETE /projects/:id/specs/:specId → 409 while the spec is in a package', async () => {
    const res = await fetch(`${baseUrl}/projects/${p1}/specs/${steel1}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toContain('package');
  });
});

describe('DELETE /packages/:id', () => {
  it('deletes the package and cascades membership; specs survive', async () => {
    const created = await json('POST', `/projects/${p1}/packages`, { name: 'Doomed' });
    const pkgId = (await data(created))['packageId'] as string;
    await json('PUT', `/packages/${pkgId}/specs`, { specIds: [steel1] });
    const res = await fetch(`${baseUrl}/packages/${pkgId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const membership = await pool.query('SELECT 1 FROM package_specs WHERE package_id = $1', [
      pkgId,
    ]);
    expect(membership.rowCount).toBe(0);
    const spec = await pool.query('SELECT 1 FROM specs WHERE id = $1', [steel1]);
    expect(spec.rowCount).toBe(1);
  });

  it('404 for unknown package', async () => {
    const res = await fetch(`${baseUrl}/packages/${ZERO}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) package id (#568)', async () => {
    const res = await fetch(`${baseUrl}/packages/not-a-uuid`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid package id' });
  });
});
