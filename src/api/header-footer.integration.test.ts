import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

// ─── Test setup ────────────────────────────────────────────────────────────
//
// Boots the real production router (router.ts) rather than a hand-wired
// stand-in — this exercises the actual route -> validateBody -> handler
// wiring the app serves, including the header/footer PUT's malformed-body
// and catchall-fidelity invariants (#476 review finding: those invariants
// were previously pinned only against a locally re-wired Express app, never
// against router.ts's own wiring).

let server: Server;
let baseUrl: string;

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
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
  await pool.end();
});

const TEST_PREFIX = 'hf-api-';

// A monotonic counter (not Date.now() alone) keeps fixture names unique even
// when several fixtures are created within the same millisecond.
let fixtureCounter = 0;
function uniqueSuffix(): string {
  fixtureCounter += 1;
  return `${Date.now()}-${fixtureCounter}`;
}

async function insertProject(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`${TEST_PREFIX}project-${uniqueSuffix()}`, 'header/footer API test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProject: no project id returned');
  return row.id;
}

async function insertPackage(projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position)
     VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${TEST_PREFIX}package-${uniqueSuffix()}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertPackage: no package id returned');
  return row.id;
}

async function insertRevision(packageId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO package_revisions
       (package_id, label, revision_type, revision_date, sort_order, attributes)
     VALUES ($1, 'Addendum 1', 'addendum', '2026-06-18'::date, 1, '{"number":1}'::jsonb)
     RETURNING id`,
    [packageId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertRevision: no revision id returned');
  return row.id;
}

afterEach(async () => {
  await pool.query(`DELETE FROM header_footer_configs`);
  await pool.query(
    `DELETE FROM package_revisions
     WHERE package_id IN (SELECT id FROM design_packages WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM design_packages WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

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

async function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

const SAMPLE_CONFIG = {
  header: { center: { content: [{ kind: 'projectName' }] } },
  footer: { right: { content: [{ kind: 'pageNumber' }] } },
};

interface ScopeCase {
  readonly name: 'library' | 'project' | 'package' | 'revision';
  readonly base: string;
  readonly makeId: () => Promise<string>;
}

async function makeClientLibraryId(): Promise<string> {
  const lib = await createLibrary({
    tier: 'client',
    name: `${TEST_PREFIX}client-${uniqueSuffix()}`,
  });
  return lib.id;
}

async function makeProjectId(): Promise<string> {
  return insertProject();
}

async function makePackageId(): Promise<string> {
  return insertPackage(await insertProject());
}

async function makeRevisionId(): Promise<string> {
  return insertRevision(await insertPackage(await insertProject()));
}

const SCOPE_CASES: readonly ScopeCase[] = [
  { name: 'library', base: '/libraries', makeId: makeClientLibraryId },
  { name: 'project', base: '/projects', makeId: makeProjectId },
  { name: 'package', base: '/packages', makeId: makePackageId },
  { name: 'revision', base: '/revisions', makeId: makeRevisionId },
];

// ─── Invariant: GET/DELETE 404 exactly when no config row exists ───────────

describe.each(SCOPE_CASES)('GET/DELETE $name/:id/header-footer — no config row', (scopeCase) => {
  it('404 on GET when no config exists for an existing anchor', async () => {
    const id = await scopeCase.makeId();
    const res = await get(`${scopeCase.base}/${id}/header-footer`);
    expect(res.status).toBe(404);
  });

  it('404 on DELETE when no config exists for an existing anchor', async () => {
    const id = await scopeCase.makeId();
    const res = await del(`${scopeCase.base}/${id}/header-footer`);
    expect(res.status).toBe(404);
  });

  it('404 on GET when the anchor itself does not exist', async () => {
    const res = await get(`${scopeCase.base}/${MISSING_UUID}/header-footer`);
    expect(res.status).toBe(404);
  });

  it('404 on DELETE when the anchor itself does not exist', async () => {
    const res = await del(`${scopeCase.base}/${MISSING_UUID}/header-footer`);
    expect(res.status).toBe(404);
  });

  it('400 on a malformed anchor id', async () => {
    const res = await get(`${scopeCase.base}/not-a-uuid/header-footer`);
    expect(res.status).toBe(400);
  });
});

// ─── Invariant: PUT never 404s except from an anchor-existence check ───────

describe.each(SCOPE_CASES)('PUT $name/:id/header-footer', (scopeCase) => {
  it('200 — creates then replaces in place (upsert), never 404ing for an existing anchor', async () => {
    const id = await scopeCase.makeId();
    const created = await put(`${scopeCase.base}/${id}/header-footer`, SAMPLE_CONFIG);
    expect(created.status).toBe(200);

    const replacement = { ...SAMPLE_CONFIG, pageNumbering: { mode: 'continuous' } };
    const replaced = await put(`${scopeCase.base}/${id}/header-footer`, replacement);
    expect(replaced.status).toBe(200);

    const fetched = await get(`${scopeCase.base}/${id}/header-footer`);
    const json = (await fetched.json()) as { data: { config: unknown } };
    expect(json.data.config).toEqual(replacement);
  });

  it('404 — PUT against a nonexistent anchor id (the only source of a PUT 404)', async () => {
    const res = await put(`${scopeCase.base}/${MISSING_UUID}/header-footer`, SAMPLE_CONFIG);
    expect(res.status).toBe(404);
  });
});

// ─── Invariant: catchall round-trip fidelity (byte-for-byte, incl. extensions) ─
//
// HeaderFooterCompositionSchema.catchall(JsonValue) sits at the TOP level, so
// any handler that reshapes the body (e.g. spreading `.shape` into a plain
// z.object()) would silently drop an unrecognized key. The REST layer never
// reshapes — validateBody parses the schema directly and the config is handed
// to upsertHeaderFooterConfig unchanged — but this pins that byte-for-byte,
// not just for the modeled fields.

describe.each(SCOPE_CASES)('PUT/GET $name/:id/header-footer — catchall fidelity', (scopeCase) => {
  it('round-trips an unrecognized top-level extension key byte-for-byte', async () => {
    const id = await scopeCase.makeId();
    const configWithExtension = { ...SAMPLE_CONFIG, xClientExtension: { note: 'keep me' } };

    const putRes = await put(`${scopeCase.base}/${id}/header-footer`, configWithExtension);
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { data: { config: unknown } };
    expect(putJson.data.config).toEqual(configWithExtension);

    const getRes = await get(`${scopeCase.base}/${id}/header-footer`);
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as { data: { config: unknown } };
    expect(getJson.data.config).toEqual(configWithExtension);
  });
});

// ─── Invariant: write-boundary errors map to 422 without leaking internals ─

describe('write-boundary error mapping', () => {
  it('422 — malformed HeaderFooterComposition body, rejected by validateBody at the route', async () => {
    const id = await makeClientLibraryId();
    const res = await put(`/libraries/${id}/header-footer`, {
      header: { center: 'not-an-object' },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { success: false; error: string };
    expect(json.error).not.toMatch(/at Object\.|node_modules|\.ts:\d+/);
    // Pins the route -> validateBody -> handler wiring specifically: status
    // 422 alone doesn't, because upsertHeaderFooterConfig's own write-time
    // schema check (src/db/queries/header-footer.ts) independently rejects
    // the same malformed body with a DIFFERENT message
    // ('header/footer config write failed validation'). Only validateBody's
    // fixed message reaches the client, so asserting it fails red if the
    // route's validateBody(HeaderFooterCompositionSchema) middleware is ever
    // dropped — matching the convention pinned in specs.integration.test.ts.
    expect(json.error).toBe('validation failed');
  });

  it('422 — client-scope PUT against a library that exists but is not tier=client', async () => {
    const companyLib = await createLibrary({
      tier: 'company',
      name: `${TEST_PREFIX}company-${uniqueSuffix()}`,
    });
    const res = await put(`/libraries/${companyLib.id}/header-footer`, SAMPLE_CONFIG);
    expect(res.status).toBe(422);
    const json = (await res.json()) as { success: false; error: string };
    expect(json.error).not.toMatch(/at Object\.|node_modules|\.ts:\d+/);
  });

  it('404, not 422 — client-scope PUT against a library id that does not exist at all', async () => {
    // Regression: assertClientLibrary (DB layer) throws the same error class for
    // "not found" and "wrong tier", so without a route-level existence guard this
    // would incorrectly resolve to 422 instead of 404.
    const res = await put(`/libraries/${MISSING_UUID}/header-footer`, SAMPLE_CONFIG);
    expect(res.status).toBe(404);
  });
});
