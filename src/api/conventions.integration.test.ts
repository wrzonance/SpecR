import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, BUILT_IN_CONVENTION_NAME } from '../db/index.js';
import type { EditingConvention } from '../db/index.js';

// ─── Test setup ───────────────────────────────────────────────────────────────

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

// Library profiles reference libraries; delete conventions first (FK-safe), then
// the test libraries by their reserved 'conv-api-*' name prefix.
afterEach(async () => {
  await pool.query(`DELETE FROM editing_conventions WHERE library_id IS NOT NULL`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'conv-api-%'`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let libCounter = 0;
async function makeLibrary(): Promise<string> {
  libCounter += 1;
  const lib = await createLibrary({
    tier: 'client',
    name: `conv-api-${Date.now()}-${libCounter}`,
  });
  return lib.id;
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

interface OkData<T> {
  readonly success: true;
  readonly data: T;
  readonly meta?: { readonly inherited: boolean };
}

// ─── GET /conventions (built-ins) ───────────────────────────────────────────────

describe('GET /conventions', () => {
  it('200 — lists the built-in Industry Default profile', async () => {
    const res = await get('/conventions');
    expect(res.status).toBe(200);
    const json = (await res.json()) as OkData<EditingConvention[]>;
    expect(json.success).toBe(true);
    const builtIn = json.data.find((c) => c.name === BUILT_IN_CONVENTION_NAME);
    expect(builtIn).toBeDefined();
    expect(builtIn?.libraryId).toBeNull();
  });
});

// ─── GET /libraries/:id/conventions (profile or flagged fallback) ───────────────

describe('GET /libraries/:id/conventions', () => {
  it('200 — flags inherited=true when the library has no profile of its own', async () => {
    const libraryId = await makeLibrary();
    const res = await get(`/libraries/${libraryId}/conventions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as OkData<EditingConvention>;
    expect(json.meta?.inherited).toBe(true);
    expect(json.data.libraryId).toBeNull();
    expect(json.data.name).toBe(BUILT_IN_CONVENTION_NAME);
  });

  it('200 — flags inherited=false and returns the library profile once set', async () => {
    const libraryId = await makeLibrary();
    await put(`/libraries/${libraryId}/conventions`, {
      name: 'Own',
      rules: { defaultEditability: 'editable' },
    });
    const res = await get(`/libraries/${libraryId}/conventions`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as OkData<EditingConvention>;
    expect(json.meta?.inherited).toBe(false);
    expect(json.data.libraryId).toBe(libraryId);
    expect(json.data.name).toBe('Own');
  });

  it('404 — unknown library', async () => {
    const res = await get(`/libraries/${MISSING_UUID}/conventions`);
    expect(res.status).toBe(404);
  });

  it('400 — malformed library id', async () => {
    const res = await get('/libraries/not-a-uuid/conventions');
    expect(res.status).toBe(400);
  });
});

// ─── PUT /libraries/:id/conventions (create / replace) ──────────────────────────

describe('PUT /libraries/:id/conventions', () => {
  it('200 — creates then replaces the library profile (upsert)', async () => {
    const libraryId = await makeLibrary();
    const created = await put(`/libraries/${libraryId}/conventions`, {
      name: 'First',
      rules: { defaultEditability: 'locked' },
    });
    expect(created.status).toBe(200);
    const createdJson = (await created.json()) as OkData<EditingConvention>;
    const firstId = createdJson.data.id;

    const replaced = await put(`/libraries/${libraryId}/conventions`, {
      name: 'Second',
      rules: { defaultEditability: 'editable' },
    });
    expect(replaced.status).toBe(200);
    const replacedJson = (await replaced.json()) as OkData<EditingConvention>;
    expect(replacedJson.data.id).toBe(firstId); // replaced in place, not duplicated
    expect(replacedJson.data.name).toBe('Second');
    expect(replacedJson.data.rules).toEqual({ defaultEditability: 'editable' });
  });

  // Regression: check-then-act upsert raced two concurrent PUTs into a unique
  // violation surfacing as 500. The atomic ON CONFLICT path (migration 025)
  // converges them on one row.
  it('200 — concurrent PUTs for one library converge without a 500', async () => {
    const libraryId = await makeLibrary();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        put(`/libraries/${libraryId}/conventions`, {
          name: `Race ${i}`,
          rules: { defaultEditability: 'editable' },
        })
      )
    );
    for (const res of results) expect(res.status).toBe(200);

    const rows = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM editing_conventions WHERE library_id = $1`,
      [libraryId]
    );
    expect(rows.rows[0]?.n).toBe('1'); // a single profile, not one per request
  });

  it('200 — round-trips unknown rule keys unchanged (open schema)', async () => {
    const libraryId = await makeLibrary();
    const rules = {
      defaultEditability: 'editable' as const,
      futureKnob: { weight: 7, labels: ['a', 'b'] },
      vendorX: 'preserve-me',
    };
    const res = await put(`/libraries/${libraryId}/conventions`, { name: 'Open', rules });
    expect(res.status).toBe(200);
    const json = (await res.json()) as OkData<EditingConvention>;
    expect(json.data.rules).toEqual(rules);
  });

  it('400 — malformed rules (wrong type)', async () => {
    const libraryId = await makeLibrary();
    const res = await put(`/libraries/${libraryId}/conventions`, {
      name: 'Bad',
      rules: { defaultEditability: 'not-a-valid-editability' },
    });
    expect(res.status).toBe(400);
  });

  it('400 — missing name', async () => {
    const libraryId = await makeLibrary();
    const res = await put(`/libraries/${libraryId}/conventions`, {
      rules: { defaultEditability: 'editable' },
    });
    expect(res.status).toBe(400);
  });

  it('422 — unsafe (ReDoS) noteBanners regex', async () => {
    const libraryId = await makeLibrary();
    const res = await put(`/libraries/${libraryId}/conventions`, {
      name: 'Unsafe',
      rules: { noteBanners: ['(a+)+$'] },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { success: false; error: string };
    expect(json.error).toMatch(/regex/i);
  });

  it('422 — oversized noteBanners regex', async () => {
    const libraryId = await makeLibrary();
    const res = await put(`/libraries/${libraryId}/conventions`, {
      name: 'Oversize',
      rules: { noteBanners: ['a'.repeat(500)] },
    });
    expect(res.status).toBe(422);
  });

  it('404 — unknown library', async () => {
    const res = await put(`/libraries/${MISSING_UUID}/conventions`, { name: 'X' });
    expect(res.status).toBe(404);
  });
});

// ─── Built-ins are not writable through any endpoint ────────────────────────────

describe('built-in profiles are read-only via the API', () => {
  it('no PUT endpoint targets a built-in; built-in row count is unchanged after a library PUT', async () => {
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM editing_conventions WHERE library_id IS NULL`
    );
    const libraryId = await makeLibrary();
    await put(`/libraries/${libraryId}/conventions`, { name: 'Lib', rules: {} });
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM editing_conventions WHERE library_id IS NULL`
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
    // The seeded built-in is untouched (still null library_id, same name).
    const builtIn = await pool.query<{ name: string }>(
      `SELECT name FROM editing_conventions WHERE library_id IS NULL`
    );
    expect(builtIn.rows[0]?.name).toBe(BUILT_IN_CONVENTION_NAME);
  });
});

// ─── POST /libraries/:id/conventions/clone ──────────────────────────────────────

describe('POST /libraries/:id/conventions/clone', () => {
  it('201 — clones the built-in into a new library profile', async () => {
    const builtInRes = await get('/conventions');
    const builtIns = (await builtInRes.json()) as OkData<EditingConvention[]>;
    const builtIn = builtIns.data.find((c) => c.name === BUILT_IN_CONVENTION_NAME);
    const libraryId = await makeLibrary();
    const res = await post(`/libraries/${libraryId}/conventions/clone`, {
      sourceId: builtIn?.id,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as OkData<EditingConvention>;
    expect(json.data.libraryId).toBe(libraryId);
    expect(json.data.rules).toEqual(builtIn?.rules);
  });

  it("201 — clones another library's profile", async () => {
    const sourceLib = await makeLibrary();
    const putRes = await put(`/libraries/${sourceLib}/conventions`, {
      name: 'Source',
      rules: { defaultEditability: 'editable', custom: 1 },
    });
    const sourceJson = (await putRes.json()) as OkData<EditingConvention>;

    const targetLib = await makeLibrary();
    const res = await post(`/libraries/${targetLib}/conventions/clone`, {
      sourceId: sourceJson.data.id,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as OkData<EditingConvention>;
    expect(json.data.libraryId).toBe(targetLib);
    expect(json.data.rules).toEqual({ defaultEditability: 'editable', custom: 1 });
  });

  it('404 — unknown source convention', async () => {
    const libraryId = await makeLibrary();
    const res = await post(`/libraries/${libraryId}/conventions/clone`, {
      sourceId: MISSING_UUID,
    });
    expect(res.status).toBe(404);
  });

  it('404 — unknown target library', async () => {
    const res = await post(`/libraries/${MISSING_UUID}/conventions/clone`, {
      sourceId: MISSING_UUID,
    });
    expect(res.status).toBe(404);
  });

  it('400 — malformed body (missing sourceId)', async () => {
    const libraryId = await makeLibrary();
    const res = await post(`/libraries/${libraryId}/conventions/clone`, {});
    expect(res.status).toBe(400);
  });
});
