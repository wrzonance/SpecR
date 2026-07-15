// src/api/header-footer-body-limit.integration.test.ts
//
// #490 — regression, end-to-end. Pins the dispatch middleware itself through
// a REAL HTTP request/response cycle rather than the unit-level predicate
// (header-footer-body-limit.test.ts already covers `isHeaderFooterCompositionWrite`
// in isolation). `src/index.ts` can't be imported directly — importing it
// opens a listener as a side effect — so this test app wires
// `createHeaderFooterBodyLimitMiddleware()`, the SAME exported factory
// `src/index.ts` calls, rather than hand-copying its dispatch logic. A
// regression to the real ordering (e.g. checking the predicate after
// body-parsing already ran, or dropping the `/mcp` early-return) lives in
// that one shared function, so it fails here exactly because both production
// and this test call it.
//
// Neither existing header/footer-adjacent integration test exercises this:
// header-footer.integration.test.ts and router-header-footer.integration.test.ts
// each build their test app with a flat `express.json()` (the REST-wide
// default only) — this is the only place in the suite that drives a request
// through the route-scoped limit at all.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';
import { MAX_IMAGE_BASE64_LENGTH } from '../lib/image-media-type.js';
import {
  createHeaderFooterBodyLimitMiddleware,
  HEADER_FOOTER_JSON_BODY_LIMIT_BYTES,
} from './header-footer-body-limit.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  // The exact production dispatch middleware — the invariant under test is
  // THIS wiring, not a stand-in that merely calls the same functions.
  app.use(createHeaderFooterBodyLimitMiddleware());
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

const TEST_PREFIX = 'hf-body-limit-';
let fixtureCounter = 0;
function uniqueSuffix(): string {
  fixtureCounter += 1;
  return `${Date.now()}-${fixtureCounter}`;
}

afterEach(async () => {
  await pool.query(`DELETE FROM header_footer_configs`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

// express.json()'s own documented default ('100kb') — comfortably below both
// this and the "double it" size used for the "over default" fixtures,
// regardless of whether that suffix resolves to a decimal or binary kilobyte.
const OVER_DEFAULT_LIMIT_TEXT_LENGTH = 200 * 1024;

function compositionWithLiteralTextLength(length: number): unknown {
  return {
    header: { center: { content: [{ kind: 'literal', text: 'A'.repeat(length) }] } },
  };
}

// The real-world scenario the route-scoped limit exists to fix: an
// `imageData` field at its own per-field cap (`MAX_IMAGE_BASE64_LENGTH`,
// `src/ast/header-footer-schemas.ts`), which is already comfortably over the
// REST-wide 100kb default. Zod's schema validates only *length*, not base64
// alphabet, so a repeated 'A' run exercises the same code path a real
// base64-encoded logo would.
function compositionWithMaxSizeImage(): unknown {
  return {
    header: {
      center: {
        content: [
          {
            kind: 'image',
            imageData: 'A'.repeat(MAX_IMAGE_BASE64_LENGTH),
            imageMediaType: 'image/png',
          },
        ],
      },
    },
  };
}

async function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('header/footer PUT body-size dispatch, end-to-end (#490)', () => {
  it('INV7: a composition body over the REST default but under the route-scoped limit succeeds', async () => {
    const lib = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}under-${uniqueSuffix()}`,
    });
    const res = await put(
      `/libraries/${lib.id}/header-footer`,
      compositionWithLiteralTextLength(OVER_DEFAULT_LIMIT_TEXT_LENGTH)
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean };
    expect(json.success).toBe(true);
  });

  it('INV7: a max-size base64 imageData field — the case the route-scoped limit exists for — parses, validates, and persists', async () => {
    const lib = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}image-${uniqueSuffix()}`,
    });
    const res = await put(`/libraries/${lib.id}/header-footer`, compositionWithMaxSizeImage());
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: { config: { header?: { center?: { content?: Array<{ imageData?: string }> } } } };
    };
    expect(json.success).toBe(true);
    const persistedContent = json.data.config.header?.center?.content;
    expect(persistedContent?.[0]?.imageData).toHaveLength(MAX_IMAGE_BASE64_LENGTH);
  });

  it('INV7: a composition body over the route-scoped limit is rejected pre-Zod with the documented 413', async () => {
    const lib = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}over-${uniqueSuffix()}`,
    });
    // Text length alone equals the derived limit; JSON wrapping overhead
    // pushes the actual request body strictly over it.
    const res = await put(
      `/libraries/${lib.id}/header-footer`,
      compositionWithLiteralTextLength(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES)
    );
    expect(res.status).toBe(413);
    const json: unknown = await res.json();
    await assertResponse('put', '/libraries/{id}/header-footer', 413, json);
    expect(json).toEqual({ success: false, error: 'payload too large' });
  });

  it('INV8: a non-header/footer route still 413s under the untouched REST default', async () => {
    const res = await put('/hf-body-limit-unrelated-route', {
      name: 'A'.repeat(OVER_DEFAULT_LIMIT_TEXT_LENGTH),
    });
    expect(res.status).toBe(413);
  });

  it('INV8: DELETE against a header/footer route still 413s under the untouched REST default (route-scoped limit is PUT-only)', async () => {
    const lib = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}delete-${uniqueSuffix()}`,
    });
    const res = await fetch(`${baseUrl}/libraries/${lib.id}/header-footer`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'A'.repeat(OVER_DEFAULT_LIMIT_TEXT_LENGTH) }),
    });
    expect(res.status).toBe(413);
  });
});
