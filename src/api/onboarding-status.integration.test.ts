import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let server: Server;
let baseUrl: string;
let sectionCounter = 0;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const a = server.address();
  baseUrl = `http://localhost:${typeof a === 'object' && a ? a.port : 3000}`;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

afterEach(async () => {
  const templates = await pool.query<{ style_template_id: string }>(
    `SELECT style_template_id FROM specs
     WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')
       AND style_template_id IS NOT NULL`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  for (const row of templates.rows) {
    await pool.query(`DELETE FROM style_templates WHERE id = $1`, [row.style_template_id]);
  }
  await pool.query(
    `DELETE FROM editing_conventions WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fapi-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-fapi-%'`);
});

async function makeSpec(libraryId: string, status: 'review' | 'active'): Promise<string> {
  sectionCounter += 1;
  const section = `09 91 ${String(sectionCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, onboarding_status)
     VALUES ($1, 't', 'docx', $2, $3) RETURNING id`,
    [section, libraryId, status]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no spec id');
  return id;
}

describe('POST /specs/:id/finalize and /reopen', () => {
  it('finalize flips review→active and surfaces it on GET /specs/:id', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-fin', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    const res = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { onboardingStatus: string } };
    expect(body.success).toBe(true);
    expect(body.data.onboardingStatus).toBe('active');

    const get = await fetch(`${baseUrl}/specs/${specId}`);
    const getBody = (await get.json()) as { data: { onboardingStatus: string } };
    expect(getBody.data.onboardingStatus).toBe('active');
  });

  it('finalize on an already-active spec is an idempotent 200 no-op', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-idem', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const res = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('active');
  });

  it('reopen flips active→review', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-reopen', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const res = await fetch(`${baseUrl}/specs/${specId}/reopen`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('review');
  });

  it('finalize on a missing spec → 404; bad id → 400', async () => {
    const missing = await fetch(`${baseUrl}/specs/${MISSING_ID}/finalize`, { method: 'POST' });
    expect(missing.status).toBe(404);
    const bad = await fetch(`${baseUrl}/specs/not-a-uuid/finalize`, { method: 'POST' });
    expect(bad.status).toBe(400);
  });

  it('GET /specs/:id surfaces onboardingStatus:review for an unfinalized spec', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-getrev', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    const get = await fetch(`${baseUrl}/specs/${specId}`);
    const body = (await get.json()) as { data: { onboardingStatus: string } };
    expect(body.data.onboardingStatus).toBe('review');
  });
});
