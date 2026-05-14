import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let testSpecId: string;
let testPartId: string;

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

  // Insert a spec with one part and one article for the round-trip smoke test
  const specRes = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ($1, $2, $3) RETURNING id`,
    ['27 13 23', 'Structured Cabling Generate Test', 'ufgs']
  );
  const specRow = specRes.rows[0];
  if (!specRow) throw new Error('failed to insert test spec');
  testSpecId = specRow.id;

  const partRes = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, NULL, 'part', 'GENERAL', 1, false) RETURNING id`,
    [testSpecId]
  );
  const partRow = partRes.rows[0];
  if (!partRow) throw new Error('failed to insert test part');
  testPartId = partRow.id;

  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, $2, 'article', 'REFERENCES', 1, false)`,
    [testSpecId, testPartId]
  );
});

afterAll(async () => {
  if (testSpecId) {
    await pool.query('DELETE FROM specs WHERE id = $1', [testSpecId]);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /specs/:id/generate (integration)', () => {
  it('returns 200 with DOCX content-type for existing spec', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('.docx');
  });

  it('returns a non-empty body (valid DOCX bytes)', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // DOCX files start with PK (ZIP magic bytes)
    expect(buffer[0]).toBe(0x50); // 'P'
    expect(buffer[1]).toBe(0x4b); // 'K'
  });

  it('returns 404 for unknown spec UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
  });

  it('returns 400 for malformed (non-UUID) spec id', async () => {
    const res = await fetch(`${baseUrl}/specs/not-a-uuid/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body['success']).toBe(false);
    expect(typeof body['error']).toBe('string');
  });
});
