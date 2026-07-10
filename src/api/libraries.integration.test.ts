import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import {
  pool,
  createLibrary,
  createSpec,
  insertTree,
  withdrawSpec,
  DEFAULT_COMPANY_LIBRARY,
} from '../db/index.js';

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
});

// Specs FK-reference libraries, so delete the test specs (paragraphs cascade)
// before their libraries. Both are namespaced by a reserved 'lib-api-%' prefix.
afterEach(async () => {
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-api-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-api-%'`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The seeded company-tier master (Default Company Master).
async function companyMasterId(): Promise<string> {
  const res = await get('/libraries');
  const json = (await res.json()) as { data: { id: string; tier: string; name: string }[] };
  // Match by name too: "default parent resolves by name" is the actual contract,
  // so a stray extra company-tier library must not satisfy this lookup.
  const company = json.data.find((l) => l.tier === 'company' && l.name === DEFAULT_COMPANY_LIBRARY);
  if (!company) throw new Error('seeded company master missing — run migrations');
  return company.id;
}

let writeCounter = 0;
function clientName(): string {
  writeCounter += 1;
  return `lib-api-write-${Date.now()}-${writeCounter}`;
}

let libCounter = 0;
async function makeLibrary(): Promise<string> {
  libCounter += 1;
  const lib = await createLibrary({ tier: 'client', name: `lib-api-${Date.now()}-${libCounter}` });
  return lib.id;
}

// Inserts one spec (3 nodes: part → article → paragraph) into a library.
async function makeSpecInLibrary(
  libraryId: string,
  section: string,
  title: string
): Promise<string> {
  const specId = await createSpec({
    section,
    title,
    source: `lib_api_${randomUUID().slice(0, 8)}`,
    libraryId,
  });
  await insertTree(
    {
      id: specId,
      section,
      title,
      parts: [
        {
          id: randomUUID(),
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: randomUUID(),
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [{ id: randomUUID(), type: 'pr1', text: 'Body.', children: [], meta: {} }],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
  return specId;
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

interface Library {
  readonly id: string;
  readonly tier: string;
  readonly name: string;
  readonly owner: string | null;
  readonly parentLibraryId: string | null;
  readonly createdAt: string;
}
interface LibrarySpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly withdrawnAt: string | null;
}
interface Ok<T> {
  readonly success: true;
  readonly data: T;
}

// ─── GET /libraries ─────────────────────────────────────────────────────────────

describe('GET /libraries', () => {
  it('200 — lists the seeded built-in reference and company libraries, ordered by tier then name', async () => {
    const res = await get('/libraries');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<Library[]>;
    expect(json.success).toBe(true);
    expect(json.data.some((l) => l.tier === 'reference')).toBe(true);
    expect(json.data.some((l) => l.tier === 'company')).toBe(true);
    // Ordered by (tier, name).
    const keys = json.data.map((l) => `${l.tier} ${l.name}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    const first = json.data[0];
    expect(typeof first?.id).toBe('string');
    expect(typeof first?.tier).toBe('string');
    expect(typeof first?.name).toBe('string');
  });
});

// ─── GET /libraries/:id/specs ────────────────────────────────────────────────────

describe('GET /libraries/:id/specs', () => {
  it('200 — returns the specs a library owns, with paragraph node counts', async () => {
    const libraryId = await makeLibrary();
    await makeSpecInLibrary(libraryId, '01 23 45', 'Alpha Spec');
    const res = await get(`/libraries/${libraryId}/specs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<LibrarySpec[]>;
    expect(json.data).toHaveLength(1);
    const row = json.data[0];
    expect(typeof row?.specId).toBe('string');
    expect(row).toMatchObject({ section: '01 23 45', title: 'Alpha Spec', nodeCount: 3 });
  });

  it('200 — active specs surface withdrawnAt: null', async () => {
    const libraryId = await makeLibrary();
    await makeSpecInLibrary(libraryId, '01 23 45', 'Alpha Spec');
    const res = await get(`/libraries/${libraryId}/specs`);
    const json = (await res.json()) as Ok<LibrarySpec[]>;
    expect(json.data[0]?.withdrawnAt).toBeNull();
  });

  it('200 — default listing hides withdrawn masters (ADR-030)', async () => {
    const libraryId = await makeLibrary();
    await makeSpecInLibrary(libraryId, '01 23 45', 'Active Spec');
    const withdrawnId = await makeSpecInLibrary(libraryId, '01 23 46', 'Withdrawn Spec');
    await withdrawSpec(withdrawnId);

    const res = await get(`/libraries/${libraryId}/specs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<LibrarySpec[]>;
    expect(json.data.map((s) => s.section)).toEqual(['01 23 45']);
  });

  it('200 — includeWithdrawn=true surfaces withdrawn masters with a withdrawnAt timestamp', async () => {
    const libraryId = await makeLibrary();
    await makeSpecInLibrary(libraryId, '01 23 45', 'Active Spec');
    const withdrawnId = await makeSpecInLibrary(libraryId, '01 23 46', 'Withdrawn Spec');
    await withdrawSpec(withdrawnId);

    const res = await get(`/libraries/${libraryId}/specs?includeWithdrawn=true`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<LibrarySpec[]>;
    expect(json.data.map((s) => s.section)).toEqual(['01 23 45', '01 23 46']);
    const withdrawn = json.data.find((s) => s.specId === withdrawnId);
    expect(typeof withdrawn?.withdrawnAt).toBe('string');
    // The surfaced UUID is exactly what POST /specs/:id/restore needs.
    expect(withdrawn?.specId).toBe(withdrawnId);
  });

  it('200 — empty array for a library with no specs', async () => {
    const libraryId = await makeLibrary();
    const res = await get(`/libraries/${libraryId}/specs`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<LibrarySpec[]>;
    expect(json.data).toEqual([]);
  });

  it('404 — unknown library', async () => {
    const res = await get(`/libraries/${MISSING_UUID}/specs`);
    expect(res.status).toBe(404);
  });

  it('400 — malformed library id', async () => {
    const res = await get('/libraries/not-a-uuid/specs');
    expect(res.status).toBe(400);
  });
});

// ─── POST /libraries/clients ─────────────────────────────────────────────────────

describe('POST /libraries/clients', () => {
  it('201 — creates a client library parented to the company master by default', async () => {
    const name = clientName();
    const res = await post('/libraries/clients', { name });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Ok<Library>;
    expect(json.data).toMatchObject({ tier: 'client', name, owner: name });
    expect(json.data.parentLibraryId).toBe(await companyMasterId());
  });

  it('201 — accepts an explicit company-tier parent', async () => {
    const parent = await companyMasterId();
    const res = await post('/libraries/clients', { name: clientName(), parentLibraryId: parent });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Ok<Library>;
    expect(json.data.parentLibraryId).toBe(parent);
  });

  it('400 — missing name', async () => {
    const res = await post('/libraries/clients', {});
    expect(res.status).toBe(400);
  });

  it('404 — unknown explicit parent', async () => {
    const res = await post('/libraries/clients', {
      name: clientName(),
      parentLibraryId: MISSING_UUID,
    });
    expect(res.status).toBe(404);
  });

  it('422 — explicit parent is not company-tier', async () => {
    const clientParent = await makeLibrary(); // a client-tier library
    const res = await post('/libraries/clients', {
      name: clientName(),
      parentLibraryId: clientParent,
    });
    expect(res.status).toBe(422);
  });

  it('409 — duplicate name', async () => {
    const name = clientName();
    expect((await post('/libraries/clients', { name })).status).toBe(201);
    expect((await post('/libraries/clients', { name })).status).toBe(409);
  });
});

// ─── PATCH /libraries/:id (rename) ───────────────────────────────────────────────

describe('PATCH /libraries/:id', () => {
  it('200 — renames a client library; owner is unchanged', async () => {
    const created = await post('/libraries/clients', { name: clientName() });
    const lib = ((await created.json()) as Ok<Library>).data;
    const newName = clientName();
    const res = await patch(`/libraries/${lib.id}`, { name: newName });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Ok<Library>;
    expect(json.data.name).toBe(newName);
    expect(json.data.owner).toBe(lib.owner); // owner immutable (§8)
  });

  it('400 — malformed library id', async () => {
    const res = await patch('/libraries/not-a-uuid', { name: clientName() });
    expect(res.status).toBe(400);
  });

  it('400 — missing name', async () => {
    const id = await makeLibrary();
    const res = await patch(`/libraries/${id}`, {});
    expect(res.status).toBe(400);
  });

  it('404 — unknown library', async () => {
    const res = await patch(`/libraries/${MISSING_UUID}`, { name: clientName() });
    expect(res.status).toBe(404);
  });

  it('422 — cannot rename a non-client (built-in) library', async () => {
    const res = await patch(`/libraries/${await companyMasterId()}`, { name: clientName() });
    expect(res.status).toBe(422);
  });

  it('409 — rename to an existing name', async () => {
    const taken = clientName();
    await post('/libraries/clients', { name: taken });
    const other = await post('/libraries/clients', { name: clientName() });
    const otherId = ((await other.json()) as Ok<Library>).data.id;
    const res = await patch(`/libraries/${otherId}`, { name: taken });
    expect(res.status).toBe(409);
  });
});
