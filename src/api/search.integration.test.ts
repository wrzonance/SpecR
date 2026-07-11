import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';
import { pool, createSpec, insertTree } from '../db/index.js';

let server: Server;
let baseUrl: string;
let specId: string;

const GENERAL_HIT = 'Firestopping at conduit penetrations shall be installed per UL systems.';
const PRODUCTS_HIT = 'Firestop sealant products for conduit penetrations at each rated opening.';

interface SearchResponse {
  success: boolean;
  data: {
    paragraphId: string;
    snippet: string;
    rank: number;
    nodeType: string;
    specSection: string;
  }[];
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

  specId = await createSpec({ section: '07 84 00', title: 'Firestopping', source: 'arcat' });
  await insertTree(
    {
      id: specId,
      section: '07 84 00',
      title: 'Firestopping',
      parts: [
        {
          id: '40000000-0000-0000-0000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '40000000-0000-0000-0000-000000000002',
              type: 'article',
              text: 'SUMMARY',
              children: [
                {
                  id: '40000000-0000-0000-0000-000000000010',
                  type: 'pr1',
                  text: GENERAL_HIT,
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
        {
          id: '40000000-0000-0000-0000-000000000003',
          type: 'part',
          text: 'PRODUCTS',
          children: [
            {
              id: '40000000-0000-0000-0000-000000000004',
              type: 'article',
              text: 'MATERIALS',
              children: [
                {
                  id: '40000000-0000-0000-0000-000000000020',
                  type: 'pr1',
                  text: PRODUCTS_HIT,
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    specId,
    pool
  );
});

afterAll(async () => {
  if (specId) await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('GET /search', () => {
  it('returns ranked, snippeted hits and validates against the documented schema', async () => {
    const res = await fetch(`${baseUrl}/search?q=firestopping%20conduit%20penetrations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    await assertResponse('get', '/search', 200, body);
    const hit = body.data.find((r) => r.paragraphId === '40000000-0000-0000-0000-000000000010');
    expect(hit).toBeDefined();
    expect(hit!.rank).toBeGreaterThan(0);
    expect(hit!.snippet).toContain('<mark>');
  });

  it('scopes by CSI part', async () => {
    const res = await fetch(`${baseUrl}/search?q=conduit&part=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    const ids = body.data.map((r) => r.paragraphId);
    expect(ids).toContain('40000000-0000-0000-0000-000000000020');
    expect(ids).not.toContain('40000000-0000-0000-0000-000000000010');
  });

  it('rejects a missing query with 400', async () => {
    const res = await fetch(`${baseUrl}/search`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('rejects an out-of-range part with 400', async () => {
    const res = await fetch(`${baseUrl}/search?q=conduit&part=9`);
    expect(res.status).toBe(400);
  });
});
