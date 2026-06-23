import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let specId: string;
let paragraphId: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 3000;
  baseUrl = `http://localhost:${port}`;

  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('09 91 00', 'Painting', 'unknown',
       (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`
  );
  specId = spec.rows[0]!.id;
  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'paragraph', 'Provide products.', 1) RETURNING id`,
    [specId]
  );
  paragraphId = para.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

const base = (): string => `${baseUrl}/specs/${specId}/paragraphs/${paragraphId}/associations`;

describe('paragraph associations REST', () => {
  it('associates a datasheet to a Part 2 paragraph, visible via REST', async () => {
    const create = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'Acme 4500 datasheet',
        externalProvider: 'projectwise',
        externalId: 'doc-123',
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { data: { id: string; label: string } };
    expect(created.data.label).toBe('Acme 4500 datasheet');

    const list = await fetch(base());
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { data: readonly { id: string }[] };
    expect(listed.data.map((a) => a.id)).toContain(created.data.id);
  });

  it('rejects an association with no identity (400)', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'no identity' }),
    });
    expect(res.status).toBe(400);
  });

  // Regression (#242 review): a half-filled DMS pair must be rejected at the API
  // boundary even when a url is present — externalProvider without externalId is
  // an unusable identity that previously slipped through to a stored row.
  it('rejects a half-filled DMS pair even with a url (400)', async () => {
    const res = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: 'half pair + url',
        url: 'https://e.com/x.pdf',
        externalProvider: 'projectwise',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('404s when the paragraph does not belong to the spec', async () => {
    const otherSpec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('01 00 00', 'General', 'unknown',
         (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       RETURNING id`
    );
    const otherId = otherSpec.rows[0]!.id;
    const res = await fetch(`${baseUrl}/specs/${otherId}/paragraphs/${paragraphId}/associations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x', url: 'https://e.com/x.pdf' }),
    });
    expect(res.status).toBe(404);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [otherId]);
  });

  it('deletes an association (204) then 404 on re-delete', async () => {
    const create = await fetch(base(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'del me', url: 'https://e.com/d.pdf' }),
    });
    const id = ((await create.json()) as { data: { id: string } }).data.id;
    const del = await fetch(`${base()}/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const again = await fetch(`${base()}/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });
});
