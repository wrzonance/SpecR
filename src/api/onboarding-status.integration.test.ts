import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

// Import a real DOCX through the O-8 onboarding pipeline so the spec has
// paragraphs + source_facts (reclassify needs them), and return its spec id.
async function importDocx(libraryId: string): Promise<string> {
  const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), 'sample.docx');
  const imp = await fetch(`${baseUrl}/libraries/${libraryId}/import`, { method: 'POST', body: form });
  expect(imp.status).toBe(202);
  const jobId = ((await imp.json()) as { data: { jobId: string } }).data.jobId;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const j = await fetch(`${baseUrl}/libraries/import/jobs/${jobId}`);
    const jb = (await j.json()) as { data: { status: string; result?: { specId: string } } };
    if (jb.data.status === 'complete') {
      const specId = jb.data.result?.specId;
      if (!specId) throw new Error('import completed without a specId');
      return specId;
    }
    if (jb.data.status === 'failed') throw new Error('onboarding import failed');
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('onboarding import did not finish');
}

describe('flexibility: an active (finalized) spec still accepts loop edits (#139)', () => {
  it('reclassify (#136), conventions (#137), style-source (#138) all work post-finalize', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fapi-flex', owner: 'o' });
    const specId = await importDocx(lib.id);

    // Finalize → active. 'active' must NOT seal the spec.
    const fin = await fetch(`${baseUrl}/specs/${specId}/finalize`, { method: 'POST' });
    expect(fin.status).toBe(200);

    // #136 reclassify still works on the active spec.
    const recl = await fetch(`${baseUrl}/specs/${specId}/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview: true }),
    });
    expect(recl.status).toBe(200);

    // #137 library conventions still writable.
    const conv = await fetch(`${baseUrl}/libraries/${lib.id}/conventions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Flex', rules: {} }),
    });
    expect(conv.status).toBe(200);

    // #138 style-source still clearable on the active spec (200 if set, 404 if not).
    const clear = await fetch(`${baseUrl}/specs/${specId}/style-source`, { method: 'DELETE' });
    expect([200, 404]).toContain(clear.status);
  }, 60_000);
});
