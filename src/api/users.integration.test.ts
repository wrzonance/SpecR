import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

// Reserved namespace: every user this file creates is labeled 'api-users-test-%'.
async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM users WHERE label LIKE 'api-users-test-%'`);
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
  await cleanup();
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('POST /users', () => {
  it('creates a user and returns the UserSummary (200)', async () => {
    const res = await req('POST', '/users', { label: 'api-users-test-create' });
    expect(res.status).toBe(200);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ label: 'api-users-test-create' });
    expect(typeof data['id']).toBe('string');
    expect(typeof data['createdAt']).toBe('string');
  });

  it('is idempotent — resolving the same label twice returns the same id (200 both times)', async () => {
    const first = await req('POST', '/users', { label: '  api-users-test-idempotent  ' });
    expect(first.status).toBe(200);
    const firstData = (await json(first))['data'] as Record<string, unknown>;

    const second = await req('POST', '/users', { label: 'api-users-test-idempotent' });
    expect(second.status).toBe(200);
    const secondData = (await json(second))['data'] as Record<string, unknown>;

    expect(secondData['id']).toBe(firstData['id']);
  });

  it('rejects a missing label with 400', async () => {
    const res = await req('POST', '/users', {});
    expect(res.status).toBe(400);
  });

  it('rejects an empty label with 400', async () => {
    const res = await req('POST', '/users', { label: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a whitespace-only label with 400', async () => {
    const res = await req('POST', '/users', { label: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects a label over 200 characters with 400', async () => {
    const res = await req('POST', '/users', { label: 'a'.repeat(201) });
    expect(res.status).toBe(400);
  });

  // #642, ADR-091 — the 200 bound is counted in Unicode CODE POINTS, not
  // UTF-16 code units. U+1F600 GRINNING FACE is 1 code point / 2 UTF-16
  // units, so a UTF-16-unit-counting regression would reject this label at
  // roughly half its real code-point length.
  it('accepts a label at exactly the 200-code-point bound built from astral (non-BMP) characters', async () => {
    const prefix = 'api-users-test-astral-';
    const label = prefix + '\u{1F600}'.repeat(200 - [...prefix].length);
    expect([...label]).toHaveLength(200);
    const res = await req('POST', '/users', { label });
    expect(res.status).toBe(200);
  });

  it('rejects a label one code point over the 200-code-point bound, built from astral characters', async () => {
    const prefix = 'api-users-test-astral-';
    const label = prefix + '\u{1F600}'.repeat(201 - [...prefix].length);
    expect([...label]).toHaveLength(201);
    const res = await req('POST', '/users', { label });
    expect(res.status).toBe(400);
  });
});

describe('GET /users', () => {
  it('lists created users', async () => {
    await req('POST', '/users', { label: 'api-users-test-list' });
    const res = await req('GET', '/users');
    expect(res.status).toBe(200);
    const data = (await json(res))['data'] as { label: string }[];
    expect(data.map((u) => u.label)).toContain('api-users-test-list');
  });
});

describe('GET /users/:id', () => {
  it('400s on a malformed id', async () => {
    const res = await req('GET', '/users/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s on an unknown id', async () => {
    const res = await req('GET', `/users/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('returns the user created via POST /users', async () => {
    const created = (await json(await req('POST', '/users', { label: 'api-users-test-get' })))[
      'data'
    ] as { id: string };
    const res = await req('GET', `/users/${created.id}`);
    expect(res.status).toBe(200);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ id: created.id, label: 'api-users-test-get' });
  });
});
