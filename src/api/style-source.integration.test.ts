import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, createSpec } from '../db/index.js';

let server: Server;
let baseUrl: string;

const createdSpecIds: string[] = [];
const createdTemplateNames: string[] = [];
const createdLibraryIds: string[] = [];

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

afterEach(async () => {
  if (createdSpecIds.length > 0) {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [createdSpecIds.splice(0)]);
  }
  if (createdTemplateNames.length > 0) {
    await pool.query(`DELETE FROM style_templates WHERE name = ANY($1::text[])`, [
      createdTemplateNames.splice(0),
    ]);
  }
  // Libraries last — CASCADEs to any library-scoped templates (specs already gone).
  if (createdLibraryIds.length > 0) {
    await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [
      createdLibraryIds.splice(0),
    ]);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function makeSpec(sourcePrefix = 'ufgs'): Promise<string> {
  // Unique source per spec — (section, source, library_id) is uniquely constrained.
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    ['27 21 00', 'Style Source API Spec', `${sourcePrefix}-${randomUUID().slice(0, 8)}`]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert spec');
  createdSpecIds.push(id);
  return id;
}

async function makeTemplate(name: string, libraryId?: string): Promise<string> {
  createdTemplateNames.push(name);
  const body = libraryId === undefined ? { name } : { name, libraryId };
  const result = await post('/templates', body);
  if (!result.ok) {
    throw new Error(`failed to create template (${result.status}): ${await result.text()}`);
  }
  const json = (await result.json()) as { data: { id: string } };
  return json.data.id;
}

const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

// ─── POST /specs/:id/style-source ───────────────────────────────────────────────

describe('POST /specs/:id/style-source', () => {
  it('assigns → GET /specs/:id reports styleSource { templateId, templateName }', async () => {
    const specId = await makeSpec();
    const name = `ss-assign-${randomUUID().slice(0, 8)}`;
    const templateId = await makeTemplate(name);

    const res = await post(`/specs/${specId}/style-source`, { templateId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data['templateId']).toBe(templateId);
    expect(body.data['templateName']).toBe(name);

    const getRes = await get(`/specs/${specId}`);
    const getBody = (await getRes.json()) as { data: Record<string, unknown> };
    expect(getBody.data['styleSource']).toEqual({ templateId, templateName: name });
  });

  it('unknown spec → 404', async () => {
    const templateId = await makeTemplate(`ss-unknown-spec-${randomUUID().slice(0, 8)}`);
    const res = await post(`/specs/${UNKNOWN_UUID}/style-source`, { templateId });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('spec not found');
  });

  it('unknown template → 404', async () => {
    const specId = await makeSpec();
    const res = await post(`/specs/${specId}/style-source`, { templateId: UNKNOWN_UUID });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('template not found');
  });

  it('re-assign replaces the previous template', async () => {
    const specId = await makeSpec();
    const firstId = await makeTemplate(`ss-reassign-a-${randomUUID().slice(0, 8)}`);
    const secondName = `ss-reassign-b-${randomUUID().slice(0, 8)}`;
    const secondId = await makeTemplate(secondName);

    await post(`/specs/${specId}/style-source`, { templateId: firstId });
    const res = await post(`/specs/${specId}/style-source`, { templateId: secondId });
    expect(res.status).toBe(200);

    const getBody = (await (await get(`/specs/${specId}`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(getBody.data['styleSource']).toEqual({
      templateId: secondId,
      templateName: secondName,
    });
  });

  it('works on a DOCX-imported spec', async () => {
    const specId = await makeSpec('arcat');
    const name = `ss-docx-${randomUUID().slice(0, 8)}`;
    const templateId = await makeTemplate(name);

    const res = await post(`/specs/${specId}/style-source`, { templateId });
    expect(res.status).toBe(200);
  });

  it('400 — non-uuid spec id', async () => {
    const templateId = await makeTemplate(`ss-bad-id-${randomUUID().slice(0, 8)}`);
    const res = await post('/specs/not-a-uuid/style-source', { templateId });
    expect(res.status).toBe(400);
  });

  it('422 — missing templateId', async () => {
    const specId = await makeSpec();
    const res = await post(`/specs/${specId}/style-source`, {});
    expect(res.status).toBe(422);
  });

  it('409 — template owned by a different library than the spec (#318)', async () => {
    // Scoped template in a fresh library; spec lives in UFGS Reference → mismatch.
    const otherLib = await createLibrary({
      tier: 'client',
      name: `ss-api-xlib-${randomUUID().slice(0, 8)}`,
    });
    createdLibraryIds.push(otherLib.id);
    const scopedSpecId = await createSpec({
      section: '27 21 00',
      title: 'ss-api-xlib-spec',
      source: `xlib-${randomUUID().slice(0, 8)}`,
      libraryId: otherLib.id,
    });
    createdSpecIds.push(scopedSpecId);
    // Assign a same-library template first so we know the template is valid…
    const name = `ss-api-xlib-tpl-${randomUUID().slice(0, 8)}`;
    const scopedTemplateId = await makeTemplate(name, otherLib.id);
    const sameLibRes = await post(`/specs/${scopedSpecId}/style-source`, {
      templateId: scopedTemplateId,
    });
    expect(sameLibRes.status).toBe(200);
    // …then try to bind it to a spec in a DIFFERENT library (UFGS Reference).
    const specElsewhere = await makeSpec();
    const res = await post(`/specs/${specElsewhere}/style-source`, {
      templateId: scopedTemplateId,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('style template belongs to a different library than the spec');
  });
});

// ─── DELETE /specs/:id/style-source ─────────────────────────────────────────────

describe('DELETE /specs/:id/style-source', () => {
  it('clears → GET reports styleSource: null', async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-clear-${randomUUID().slice(0, 8)}`);
    await post(`/specs/${specId}/style-source`, { templateId });

    const res = await del(`/specs/${specId}/style-source`);
    expect(res.status).toBe(200);

    const getBody = (await (await get(`/specs/${specId}`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(getBody.data['styleSource']).toBeNull();
  });

  it('is idempotent — clearing an already-null association returns 200', async () => {
    const specId = await makeSpec();
    const res = await del(`/specs/${specId}/style-source`);
    expect(res.status).toBe(200);
  });

  it('unknown spec → 404', async () => {
    const res = await del(`/specs/${UNKNOWN_UUID}/style-source`);
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /templates/:id RESTRICT enforcement (#138) ──────────────────────────

describe('DELETE /templates/:id while referenced', () => {
  it('409, template still exists', async () => {
    const specId = await makeSpec();
    const name = `ss-restrict-${randomUUID().slice(0, 8)}`;
    const templateId = await makeTemplate(name);
    await post(`/specs/${specId}/style-source`, { templateId });

    const res = await del(`/templates/${templateId}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('in use by 1 spec');

    // Template must still exist.
    const check = await pool.query(`SELECT 1 FROM style_templates WHERE id = $1`, [templateId]);
    expect(check.rows).toHaveLength(1);
  });

  it('204 once the reference is cleared', async () => {
    const specId = await makeSpec();
    const templateId = await makeTemplate(`ss-restrict-then-delete-${randomUUID().slice(0, 8)}`);
    await post(`/specs/${specId}/style-source`, { templateId });
    await del(`/specs/${specId}/style-source`);

    const res = await del(`/templates/${templateId}`);
    expect(res.status).toBe(204);
  });
});
