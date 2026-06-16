import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, insertTree } from '../db/index.js';
import { SpecTreeSchema } from '../ast/index.js';
import type { SpecTree, SpecNode } from '../ast/index.js';

const ZERO = '00000000-0000-0000-0000-000000000000';

let server: Server;
let baseUrl: string;
let companyId: string;
const projectIds: string[] = [];
const masterIds: string[] = [];
let p1: string; // project under test
let steel1: string; // P1 clone of 05 12 00
let hvac1: string; // P1 clone of 23 09 23
let pkgFull: string; // package holding [steel1, hvac1]
let pkgEmpty: string; // package with no member specs

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

function pr1(text: string): SpecNode {
  return { id: randomUUID(), type: 'pr1', text, children: [], meta: {} };
}

function smallTree(specId: string, section: string, title: string, body: string): SpecTree {
  return {
    id: specId,
    section,
    title,
    parts: [
      {
        id: randomUUID(),
        type: 'part',
        text: 'GENERAL',
        children: [
          {
            id: randomUUID(),
            type: 'article',
            text: 'SUMMARY',
            children: [pr1(body)],
            meta: {},
          },
        ],
        meta: {},
      },
    ],
  };
}

async function insertMasterWithTree(section: string, title: string, body: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, companyId]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert master ${section}`);
  masterIds.push(row.id);
  await insertTree(smallTree(row.id, section, title, body), row.id, pool);
  return row.id;
}

async function createPackage(projectId: string, name: string): Promise<string> {
  const res = await json('POST', `/projects/${projectId}/packages`, { name });
  return (await data(res))['packageId'] as string;
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
  if (!lib.rows[0]) throw new Error('Default Company Master missing — run migrations');
  companyId = lib.rows[0].id;
  await insertMasterWithTree('05 12 00', 'Structural Steel Framing', 'Shop-fabricated steel.');
  await insertMasterWithTree('23 09 23', 'Direct Digital Control', 'DDC system for HVAC.');
  const created = await json('POST', '/projects', {
    name: `Rev API P1 ${Date.now()}`,
    sourceLibraryIds: [companyId],
  });
  p1 = (await data(created))['projectId'] as string;
  projectIds.push(p1);
  const addSteel = await json('POST', `/projects/${p1}/specs`, { section: '05 12 00' });
  steel1 = (await data(addSteel))['specId'] as string;
  const addHvac = await json('POST', `/projects/${p1}/specs`, { section: '23 09 23' });
  hvac1 = (await data(addHvac))['specId'] as string;
  pkgFull = await createPackage(p1, '100% CD Set');
  pkgEmpty = await createPackage(p1, 'Placeholder Package');
  const put = await json('PUT', `/packages/${pkgFull}/specs`, { specIds: [steel1, hvac1] });
  if (put.status !== 200) throw new Error('failed to set package membership');
});

afterAll(async () => {
  // design_packages delete cascades revisions → snapshot rows → membership
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [masterIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /packages/:id/revisions', () => {
  it('issues a revision: 201 with label, issuedAt, specCount', async () => {
    const res = await json('POST', `/packages/${pkgFull}/revisions`, { label: '50% DD' });
    expect(res.status).toBe(201);
    const d = await data(res);
    expect(typeof d['revisionId']).toBe('string');
    expect(d['packageId']).toBe(pkgFull);
    expect(d['label']).toBe('50% DD');
    expect(typeof d['issuedAt']).toBe('string');
    expect(d['specCount']).toBe(2);
  });

  it('409 on duplicate label within the same package — UNIQUE (package_id, label)', async () => {
    const res = await json('POST', `/packages/${pkgFull}/revisions`, { label: '50% DD' });
    expect(res.status).toBe(409);
  });

  it('uniqueness is package-scoped: same label on another package → 201', async () => {
    const res = await json('POST', `/packages/${pkgEmpty}/revisions`, { label: '50% DD' });
    expect(res.status).toBe(201);
    expect((await data(res))['specCount']).toBe(0);
  });

  it('404 for unknown package', async () => {
    const res = await json('POST', `/packages/${ZERO}/revisions`, { label: 'X' });
    expect(res.status).toBe(404);
  });

  it('422 for empty label', async () => {
    const res = await json('POST', `/packages/${pkgFull}/revisions`, { label: '' });
    expect(res.status).toBe(422);
  });

  it('issuance flips member specs lifecycle_state to issued (ADR-018 D3)', async () => {
    async function lifecycle(id: string): Promise<string> {
      const r = await pool.query<{ lifecycle_state: string }>(
        'SELECT lifecycle_state FROM specs WHERE id = $1',
        [id]
      );
      return r.rows[0]!.lifecycle_state;
    }
    // Archive one member first: issuance must never reactivate an archived spec.
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [hvac1]);
    try {
      const res = await json('POST', `/packages/${pkgFull}/revisions`, { label: 'Issuance Hook' });
      expect(res.status).toBe(201);

      expect(await lifecycle(steel1)).toBe('issued'); // draft → issued
      expect(await lifecycle(hvac1)).toBe('archived'); // archived stays archived
    } finally {
      // Restore so later tests in the file see a clean draft member, even if an
      // assertion above throws.
      await pool.query(`UPDATE specs SET lifecycle_state = 'draft' WHERE id = $1`, [hvac1]);
    }
  });
});

describe('GET /revisions/:id', () => {
  let revisionId: string;

  beforeAll(async () => {
    const res = await json('POST', `/packages/${pkgFull}/revisions`, { label: '100% CD' });
    revisionId = (await data(res))['revisionId'] as string;
  });

  it('returns frozen trees in position order; each round-trips SpecTreeSchema', async () => {
    const res = await json('GET', `/revisions/${revisionId}`);
    expect(res.status).toBe(200);
    const d = await data(res);
    expect(d['revisionId']).toBe(revisionId);
    expect(d['label']).toBe('100% CD');
    const specs = d['specs'] as Array<Record<string, unknown>>;
    expect(specs.map((s) => [s['specId'], s['position']])).toEqual([
      [steel1, 1],
      [hvac1, 2],
    ]);
    for (const entry of specs) {
      // Acceptance: snapshot tree re-validates against SpecTreeSchema
      const tree = SpecTreeSchema.parse(entry['tree']);
      expect(tree.id).toBe(entry['specId']);
    }
    const steelTree = SpecTreeSchema.parse(specs[0]?.['tree']);
    expect(steelTree.section).toBe('05 12 00');
    expect(JSON.stringify(steelTree)).toContain('Shop-fabricated steel.');
  });

  it('snapshot immutable: post-issuance paragraph edits do not alter the stored tree', async () => {
    await pool.query(`UPDATE paragraphs SET text = 'MUTATED AFTER ISSUANCE' WHERE spec_id = $1`, [
      steel1,
    ]);
    const res = await json('GET', `/revisions/${revisionId}`);
    expect(res.status).toBe(200);
    const specs = (await data(res))['specs'] as Array<Record<string, unknown>>;
    const frozen = JSON.stringify(specs[0]?.['tree']);
    expect(frozen).toContain('Shop-fabricated steel.');
    expect(frozen).not.toContain('MUTATED AFTER ISSUANCE');
  });

  it('404 for unknown revision', async () => {
    const res = await json('GET', `/revisions/${ZERO}`);
    expect(res.status).toBe(404);
  });
});

describe('cascade (migration 021)', () => {
  it('deleting a package removes its revisions and snapshot rows; specs survive', async () => {
    const pkgId = await createPackage(p1, 'Doomed Pkg');
    await json('PUT', `/packages/${pkgId}/specs`, { specIds: [hvac1] });
    const issued = await json('POST', `/packages/${pkgId}/revisions`, { label: 'Addendum 1' });
    const revisionId = (await data(issued))['revisionId'] as string;
    const del = await fetch(`${baseUrl}/packages/${pkgId}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const revs = await pool.query('SELECT 1 FROM package_revisions WHERE id = $1', [revisionId]);
    expect(revs.rowCount).toBe(0);
    const snaps = await pool.query('SELECT 1 FROM package_revision_specs WHERE revision_id = $1', [
      revisionId,
    ]);
    expect(snaps.rowCount).toBe(0);
    const spec = await pool.query('SELECT 1 FROM specs WHERE id = $1', [hvac1]);
    expect(spec.rowCount).toBe(1);
  });
});
