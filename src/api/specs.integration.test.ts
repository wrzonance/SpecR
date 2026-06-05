import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let testSpecId: string;

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

  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    ['27 21 00', 'Structured Cabling', 'ufgs']
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test spec');
  testSpecId = row.id;

  const partResult = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'part', 'PART 1 - GENERAL', 0) RETURNING id`,
    [testSpecId]
  );
  const partRow = partResult.rows[0];
  if (!partRow) throw new Error('failed to insert test part paragraph');
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, 'article', 'SUMMARY', 0)`,
    [testSpecId, partRow.id]
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

describe('GET /specs/:id (integration)', () => {
  it('returns 200 with SpecTree for existing spec', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    expect(data['id']).toBe(testSpecId);
    expect(data['section']).toBe('27 21 00');
    expect(data['title']).toBe('Structured Cabling');
    expect(Array.isArray(data['parts'])).toBe(true);
  });

  it('returns 404 for unknown UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['error']).toBe('spec not found');
  });

  it('regression #152: parsed spec returns reconstructed paragraph tree, not parts: []', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    const parts = data['parts'] as readonly Record<string, unknown>[];
    expect(parts.length).toBe(1);
    expect(parts[0]?.['type']).toBe('part');
    expect(parts[0]?.['text']).toBe('PART 1 - GENERAL');
    const children = parts[0]?.['children'] as readonly Record<string, unknown>[];
    expect(children.length).toBe(1);
    expect(children[0]?.['text']).toBe('SUMMARY');
  });
});

describe('GET /specs (integration)', () => {
  it('returns 200 with a list containing the seeded spec', async () => {
    const res = await fetch(`${baseUrl}/specs`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    const data = body['data'] as readonly Record<string, unknown>[];
    const entry = data.find((s) => s['specId'] === testSpecId);
    expect(entry).toBeDefined();
    expect(entry?.['section']).toBe('27 21 00');
    expect(typeof entry?.['nodeCount']).toBe('number');
  });
});

describe('GET /specs/:id/tree (integration)', () => {
  let paragraphId: string;

  beforeAll(async () => {
    const para = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
       VALUES ($1, NULL, 'part', 'GENERAL', 0, false) RETURNING id`,
      [testSpecId]
    );
    const paraRow = para.rows[0];
    if (!paraRow) throw new Error('failed to insert test paragraph');
    paragraphId = paraRow.id;
    await pool.query(
      `INSERT INTO spec_references
         (source_spec_id, source_paragraph_id, target_type,
          target_spec_section, target_spec_id, standard_code, reference_text)
       VALUES ($1, $2, 'section', '09 22 00', NULL, NULL, '09 22 00')`,
      [testSpecId, paragraphId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM spec_references WHERE source_spec_id = $1', [testSpecId]);
    await pool.query('DELETE FROM paragraphs WHERE spec_id = $1', [testSpecId]);
  });

  it('returns 200 with populated tree and references', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/tree`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body['success']).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    const tree = data['tree'] as Record<string, unknown>;
    expect(tree['id']).toBe(testSpecId);
    const parts = tree['parts'] as readonly Record<string, unknown>[];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.['type']).toBe('part');
    expect(parts[0]?.['text']).toBe('GENERAL');
    const references = data['references'] as readonly Record<string, unknown>[];
    expect(references).toHaveLength(1);
    expect(references[0]?.['targetSection']).toBe('09 22 00');
    expect(references[0]?.['isResolved']).toBe(false);
    expect(references[0]?.['isBroken']).toBe(false);
  });

  it('returns 404 for unknown UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000/tree`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['error']).toBe('spec not found');
  });
});

describe('PATCH /specs/:id (integration)', () => {
  it('returns 200 with updated SpecSummary', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Cabling Spec' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['specId']).toBe(testSpecId);
    expect(data['title']).toBe('Updated Cabling Spec');
    expect(data['section']).toBe('27 21 00');
  });

  it('returns 422 for empty title', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(422);
    expect(body['error']).toBe('validation failed');
  });

  it('returns 422 for invalid section format', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27210' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 404 for unknown UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'whatever' }),
    });
    expect(res.status).toBe(404);
  });

  it('accepts a dotted-suffix section', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27 21 00.10' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body['data'] as Record<string, unknown>)['section']).toBe('27 21 00.10');
  });

  it('accepts an agency-suffix section', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27 21 00.10 20' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body['data'] as Record<string, unknown>)['section']).toBe('27 21 00.10 20');
  });
});
