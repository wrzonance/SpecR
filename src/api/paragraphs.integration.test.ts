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
let nodeId: string;

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

  specId = await insertSpec('27 21 00', 'Structured Cabling');
  otherSpecId = await insertSpec('09 91 26', 'Painting');

  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, NULL, 'pr1', 'Provide cabling.', 0, 1) RETURNING id`,
    [specId]
  );
  const paraRow = para.rows[0];
  if (!paraRow) throw new Error('failed to insert test paragraph');
  nodeId = paraRow.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specId, otherSpecId]]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('PATCH /specs/:id/paragraphs/:nodeId (integration)', () => {
  it('updates text and bumps base_version', async () => {
    const before = await pool.query<{ base_version: number }>(
      'SELECT base_version FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    const beforeVersion = before.rows[0]?.base_version ?? 0;

    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide Category 6A cabling.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; type: string; text: string; children: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(nodeId);
    expect(body.data.type).toBe('pr1');
    expect(body.data.text).toBe('Provide Category 6A cabling.');
    expect(Array.isArray(body.data.children)).toBe(true);

    const after = await pool.query<{ base_version: number; text: string }>(
      'SELECT base_version, text FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    expect(after.rows[0]?.text).toBe('Provide Category 6A cabling.');
    expect(after.rows[0]?.base_version).toBe(beforeVersion + 1);
  });

  it('returns 404 for an unknown nodeId', async () => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${unknown}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'whatever' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the nodeId belongs to a different spec', async () => {
    const before = await pool.query<{ text: string }>('SELECT text FROM paragraphs WHERE id = $1', [
      nodeId,
    ]);
    const beforeText = before.rows[0]?.text;

    const res = await fetch(`${baseUrl}/specs/${otherSpecId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cross-spec edit' }),
    });
    expect(res.status).toBe(403);

    const unchanged = await pool.query<{ text: string }>(
      'SELECT text FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    expect(unchanged.rows[0]?.text).toBe(beforeText);
  });

  it('returns 400 for empty text', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid nodeId', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/not-a-uuid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'valid text' }),
    });
    expect(res.status).toBe(400);
  });
});
