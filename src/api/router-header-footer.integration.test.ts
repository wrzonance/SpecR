import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

// ─── Invariant: the header/footer routes are reachable through the REAL
// router (src/api/router.ts), not only through the isolated test apps that
// header-footer.integration.test.ts / header-footer-resolve.integration.test.ts
// build around the handlers directly. Also pins "PUT never 404s from its own
// semantics" — the only 404 a PUT can produce comes from the DB/FK layer
// (structured JSON), never from Express failing to match the route at all
// (which would surface as its own unmatched-route 404, distinguishable by a
// non-JSON body). See the #476 design doc's "PUT-never-404s-except-FK"
// decision.

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

const TEST_PREFIX = 'hf-router-';
let fixtureCounter = 0;
function uniqueSuffix(): string {
  fixtureCounter += 1;
  return `${Date.now()}-${fixtureCounter}`;
}

afterEach(async () => {
  await pool.query(`DELETE FROM header_footer_configs`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

const SAMPLE_CONFIG = {
  header: { center: { content: [{ kind: 'projectName' }] } },
  footer: { right: { content: [{ kind: 'pageNumber' }] } },
};

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

async function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('router.ts header/footer wiring (#476)', () => {
  it('PUT against an existing client library succeeds via the real router (never a spurious 404)', async () => {
    const lib = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}client-${uniqueSuffix()}`,
    });
    const res = await put(`/libraries/${lib.id}/header-footer`, SAMPLE_CONFIG);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('PUT against a nonexistent project surfaces a structured JSON 404 from the FK layer, not an unmatched-route 404', async () => {
    const res = await put(`/projects/${MISSING_UUID}/header-footer`, SAMPLE_CONFIG);
    // The route itself matched (this is the invariant under test): the 404
    // carries our own ApiResponse JSON shape, never Express's default
    // text/html "Cannot PUT ..." body a missing route registration would emit.
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toContain('referenced scope not found');
  });

  it('GET /projects/:id/header-footer/resolved is reachable through the real router', async () => {
    const res = await fetch(`${baseUrl}/projects/${MISSING_UUID}/header-footer/resolved`);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.status).toBe(404);
  });
});
