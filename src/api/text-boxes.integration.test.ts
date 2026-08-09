import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';
import { pool } from '../db/index.js';
import type { ObjectMeta } from '../ast/index.js';

let server: Server;
let baseUrl: string;
let specId: string;
let projectId: string;
const suffix = randomUUID().slice(0, 8);

const meta: ObjectMeta = {
  kind: 'textBox',
  floating: true,
  generation: 'drawingml',
  blob: [{ 'w:drawing': [] }],
};

async function req(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
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
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 3000}`;

  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`text-box-api-${suffix}`]
  );
  projectId = project.rows[0]!.id;
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('09 91 00', 'Painting', $1,
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [`text-box-api-${suffix}`]
  );
  specId = spec.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  const object = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position, object_data)
     VALUES ($1, 'object', '', 1, $2::jsonb) RETURNING id`,
    [specId, JSON.stringify(meta)]
  );
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, 'objectText', 'Route this text box.', 2)`,
    [specId, object.rows[0]!.id]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('text-box REST report (#409)', () => {
  it('returns one text box at spec scope and matches OpenAPI', async () => {
    const response = await req(`/specs/${specId}/text-boxes`);
    expect(response.status).toBe(200);
    await assertResponse('get', '/specs/{id}/text-boxes', 200, response.body);
    const body = response.body as {
      data: {
        summary: { textBoxes: number };
        textBoxes: { interiorText: readonly string[] }[];
      };
    };
    expect(body.data.summary).toEqual({ textBoxes: 1 });
    expect(body.data.textBoxes[0]?.interiorText).toEqual(['Route this text box.']);
  });

  it('aggregates the same report at project scope', async () => {
    const response = await req(`/projects/${projectId}/text-boxes`);
    expect(response.status).toBe(200);
    await assertResponse('get', '/projects/{id}/text-boxes', 200, response.body);
    const body = response.body as { data: { summary: { textBoxes: number } } };
    expect(body.data.summary.textBoxes).toBe(1);
  });
});
