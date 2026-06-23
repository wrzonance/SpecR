import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let specId: string;
let nodeId: string;
let otherSpecId: string;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
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
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const libRow = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
  );
  const libraryId = libRow.rows[0]!.id;

  const specRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 99', 'Editability API Test', 'arcat', $1)
     RETURNING id`,
    [libraryId]
  );
  specId = specRow.rows[0]!.id;

  const nodeRow = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', 'Test paragraph.', 1)
     RETURNING id`,
    [specId]
  );
  nodeId = nodeRow.rows[0]!.id;

  const otherSpecRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 98', 'Editability API Other Spec', 'arcat', $1)
     RETURNING id`,
    [libraryId]
  );
  otherSpecId = otherSpecRow.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [otherSpecId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PATCH /specs/:id/paragraphs/:nodeId/editability', () => {
  it('sets the override and returns 200', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
    expect((r.body as { data: { editability: string } }).data.editability).toBe('note');
  });

  it('clears the override with explicit null', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: null,
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { editability: null } }).data.editability).toBeNull();
  });

  it('rejects a bad value with 400', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'frozen',
    });
    expect(r.status).toBe(400);
  });

  it('404 for an unknown node', async () => {
    const r = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/00000000-0000-0000-0000-000000000000/editability`,
      { editability: 'note' }
    );
    expect(r.status).toBe(404);
  });

  it('403 when the node belongs to another spec', async () => {
    const r = await req('PATCH', `/specs/${otherSpecId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(403);
  });
});
