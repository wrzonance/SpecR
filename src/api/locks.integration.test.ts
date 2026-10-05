import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { MAX_LABEL_LENGTH } from '../lib/label-length.js';

const ZERO = '00000000-0000-0000-0000-000000000000';
const HOLDER_A = 'user:alice';
const HOLDER_B = 'user:bob';

let server: Server;
let baseUrl: string;
let specId: string;

async function lockReq(
  method: string,
  body?: unknown
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/specs/${specId}/lock`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
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

  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 95 00', 'Lock API Test', 'arcat',
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`
  );
  specId = r.rows[0]!.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await pool.query('DELETE FROM spec_locks WHERE spec_id = $1', [specId]);
});

describe('lock endpoints (integration)', () => {
  it('acquire → held → release cycle', async () => {
    const acquired = await lockReq('PUT', { holder: HOLDER_A });
    expect(acquired.status).toBe(200);
    expect(acquired.body.success).toBe(true);

    const held = await lockReq('PUT', { holder: HOLDER_B });
    expect(held.status).toBe(409);
    expect(held.body.holder).toBe(HOLDER_A);

    const released = await lockReq('DELETE', { holder: HOLDER_A });
    expect(released.status).toBe(200);

    const reacquired = await lockReq('PUT', { holder: HOLDER_B });
    expect(reacquired.status).toBe(200);
  });

  it('GET reflects the live lock and clears after release', async () => {
    await lockReq('PUT', { holder: HOLDER_A });
    const got = await lockReq('GET');
    expect(got.status).toBe(200);
    expect((got.body.data as { locked: boolean }).locked).toBe(true);

    await lockReq('DELETE', { holder: HOLDER_A });
    const after = await lockReq('GET');
    expect((after.body.data as { locked: boolean }).locked).toBe(false);
  });

  it('release by a non-holder is refused with 409', async () => {
    await lockReq('PUT', { holder: HOLDER_A });
    const res = await lockReq('DELETE', { holder: HOLDER_B });
    expect(res.status).toBe(409);
  });

  it('acquire on an unknown spec → 404', async () => {
    const res = await fetch(`${baseUrl}/specs/${ZERO}/lock`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ holder: HOLDER_A }),
    });
    expect(res.status).toBe(404);
  });

  it('acquire without a holder → 400', async () => {
    const res = await lockReq('PUT', {});
    expect(res.status).toBe(400);
  });

  // #692: holder had a minimum but no maximum, so one request could store an
  // arbitrarily long label and echo it back in every 409.
  it('lock: over-length holder is rejected on acquire → 400, nothing stored', async () => {
    const res = await lockReq('PUT', { holder: 'x'.repeat(MAX_LABEL_LENGTH + 1) });
    expect(res.status).toBe(400);
    expect(((await lockReq('GET')).body.data as { locked: boolean }).locked).toBe(false);
  });

  it('lock: a holder of exactly the maximum length is accepted', async () => {
    const res = await lockReq('PUT', { holder: 'x'.repeat(MAX_LABEL_LENGTH) });
    expect(res.status).toBe(200);
  });

  it('lock: over-length holder is rejected on release → 400', async () => {
    const res = await lockReq('DELETE', { holder: 'x'.repeat(MAX_LABEL_LENGTH + 1) });
    expect(res.status).toBe(400);
  });
});
