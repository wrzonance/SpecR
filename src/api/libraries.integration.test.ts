import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, createSpec, insertTree } from '../db/index.js';

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
