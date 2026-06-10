import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

// End-to-end proof of the demo edit mutations: routing -> handler -> DB cascade.

let server: Server;
let baseUrl: string;

const SPEC_A = 'eeeeeeee-0000-0000-0000-00000000000a';
const SPEC_B = 'eeeeeeee-0000-0000-0000-00000000000b';
const PROJ = 'eeeeeeee-0000-0000-0000-0000000000c1';
const PARA1 = 'eeeeeeee-0000-0000-0000-0000000000a3';
let ref1Id: string;

interface TreeResp {
  readonly data: {
    readonly tree: { readonly parts: readonly unknown[] };
    readonly references: readonly unknown[];
  };
}
interface PatchResp {
  readonly data: { readonly text: string };
}

async function readBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
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
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

beforeEach(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1) OR source = 'test-api-mut'`, [
    [SPEC_A, SPEC_B],
  ]);
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES
       ($1, '09 29 00', 'Gypsum Board', 'test-api-mut'),
       ($2, '09 22 00', 'Supports for Plaster', 'test-api-mut')`,
    [SPEC_A, SPEC_B]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, NULL, 'pr1', 'Comply with Section 09 22 00.', 1)`,
    [PARA1, SPEC_A]
  );
  const ref = await pool.query<{ id: string }>(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text)
     VALUES ($1, $2, 'section', '09 22 00', $3, '09 22 00') RETURNING id`,
    [SPEC_A, PARA1, SPEC_B]
  );
  ref1Id = ref.rows[0]!.id;
});

afterEach(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1)`, [[SPEC_A, SPEC_B]]);
});

describe('DELETE /specs/:id/paragraphs/:paragraphId', () => {
  it('deletes the paragraph and cascades to its reference', async () => {
    const res = await fetch(`${baseUrl}/specs/${SPEC_A}/paragraphs/${PARA1}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const tree = await readBody<TreeResp>(await fetch(`${baseUrl}/specs/${SPEC_A}/tree`));
    expect(tree.data.tree.parts).toHaveLength(0);
    expect(tree.data.references).toHaveLength(0);
  });

  it('returns 404 for an unknown paragraph', async () => {
    const res = await fetch(
      `${baseUrl}/specs/${SPEC_A}/paragraphs/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /specs/:id/paragraphs/:paragraphId', () => {
  it('updates the paragraph body text', async () => {
    const res = await fetch(`${baseUrl}/specs/${SPEC_A}/paragraphs/${PARA1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Comply with the framing requirements.' }),
    });
    expect(res.status).toBe(200);
    const body = await readBody<PatchResp>(res);
    expect(body.data.text).toBe('Comply with the framing requirements.');
  });

  it('returns 422 for empty text', async () => {
    const res = await fetch(`${baseUrl}/specs/${SPEC_A}/paragraphs/${PARA1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /specs/:id/references/:refId', () => {
  it('deletes one reference but keeps its paragraph', async () => {
    const res = await fetch(`${baseUrl}/specs/${SPEC_A}/references/${ref1Id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const tree = await readBody<TreeResp>(await fetch(`${baseUrl}/specs/${SPEC_A}/tree`));
    expect(tree.data.references).toHaveLength(0);
    expect(tree.data.tree.parts).toHaveLength(1); // paragraph survives
  });

  it('returns 404 for an unknown reference', async () => {
    const res = await fetch(
      `${baseUrl}/specs/${SPEC_A}/references/00000000-0000-0000-0000-000000000000`,
      { method: 'DELETE' }
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /specs/:id', () => {
  it('deletes a spec that is not in any project', async () => {
    const res = await fetch(`${baseUrl}/specs/${SPEC_B}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const after = await fetch(`${baseUrl}/specs/${SPEC_B}/tree`);
    expect(after.status).toBe(404);
  });

  it('returns 409 when the spec is still pinned to a project', async () => {
    await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'Pinned')`, [PROJ]);
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
      [PROJ, SPEC_A]
    );
    const res = await fetch(`${baseUrl}/specs/${SPEC_A}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an unknown spec', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});
