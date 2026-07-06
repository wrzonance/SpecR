import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let specId: string;
let otherSpecId: string;
let anchorId: string;
let partId: string;

async function insertSpec(section: string, title: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    [section, title]
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test spec');
  return row.id;
}

async function insertParagraph(
  spec: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [spec, parentId, nodeType, text, position]
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test paragraph');
  return row.id;
}

async function postInsert(spec: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/specs/${spec}/paragraphs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  specId = await insertSpec('27 21 10', 'Insert Endpoint Test');
  otherSpecId = await insertSpec('09 91 27', 'Insert Endpoint Other');
  partId = await insertParagraph(specId, null, 'part', 'GENERAL', 1);
  anchorId = await insertParagraph(specId, partId, 'pr1', 'Anchor paragraph.', 1);
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specId, otherSpecId]]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /specs/:id/paragraphs (integration)', () => {
  it('creates a sibling after the anchor and responds 201 with the SpecNode', async () => {
    const res = await postInsert(specId, { anchorNodeId: anchorId, text: 'Inserted line.' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; type: string; text: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.type).toBe('pr1'); // defaulted to the anchor's type
    expect(body.data.text).toBe('Inserted line.');

    const row = await pool.query<{ parent_id: string; position: number }>(
      'SELECT parent_id, position FROM paragraphs WHERE id = $1',
      [body.data.id]
    );
    expect(row.rows[0]?.parent_id).toBe(partId);
    expect(row.rows[0]?.position).toBe(2);
  });

  it('rejects a body without anchorNodeId or with empty text (400)', async () => {
    const missing = await postInsert(specId, { text: 'No anchor.' });
    expect(missing.status).toBe(400);
    const empty = await postInsert(specId, { anchorNodeId: anchorId, text: '' });
    expect(empty.status).toBe(400);
  });

  it('404s for an unknown anchor', async () => {
    const res = await postInsert(specId, {
      anchorNodeId: 'c2000000-0000-4000-8000-0000000000aa',
      text: 'Orphan.',
    });
    expect(res.status).toBe(404);
  });

  it('403s when the anchor belongs to another spec', async () => {
    const res = await postInsert(otherSpecId, { anchorNodeId: anchorId, text: 'Wrong spec.' });
    expect(res.status).toBe(403);
  });

  it('422s when the defaulted type is not insertable (part anchor)', async () => {
    const res = await postInsert(specId, { anchorNodeId: partId, text: 'After a part.' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('part');
  });

  it('409s a stale expectedVersion with the current version', async () => {
    const res = await postInsert(specId, {
      anchorNodeId: anchorId,
      text: 'Stale.',
      expectedVersion: 999999,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; currentVersion?: number };
    expect(body.success).toBe(false);
    expect(body.currentVersion).toBeGreaterThanOrEqual(1);
  });
});
