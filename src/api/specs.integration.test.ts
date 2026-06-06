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
    `INSERT INTO specs (section, title, source) VALUES ($1, $2, $3) RETURNING id`,
    ['27 21 00', 'Structured Cabling', 'ufgs']
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test spec');
  testSpecId = row.id;
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
