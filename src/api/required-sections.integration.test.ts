import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let projectId: string;
let packageId: string;

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
  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('req-api-it') RETURNING id`
  );
  projectId = p.rows[0]!.id;
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, 'pkg', 1) RETURNING id`,
    [projectId]
  );
  packageId = pkg.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]); // cascades required_sections + packages
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('required-sections API', () => {
  it('PUT replaces the baseline and GET returns it', async () => {
    const put = await req('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30 00', title: 'Concrete' }, { section: '09 91 00' }],
    });
    expect(put.status).toBe(200);
    expect((put.body as { success: boolean }).success).toBe(true);
    expect(
      (put.body as { data: Array<{ section: string; position: number }> }).data.map((r) => [
        r.section,
        r.position,
      ])
    ).toEqual([
      ['03 30 00', 1],
      ['09 91 00', 2],
    ]);
    const get = await req('GET', `/projects/${projectId}/required-sections`);
    expect(get.status).toBe(200);
    expect((get.body as { data: unknown[] }).data).toHaveLength(2);
  });

  it('PUT package with seedFrom=baseline copies the baseline', async () => {
    const seeded = await req(
      'PUT',
      `/projects/${projectId}/packages/${packageId}/required-sections`,
      { seedFrom: 'baseline' }
    );
    expect(seeded.status).toBe(200);
    expect(
      (seeded.body as { data: Array<{ section: string }> }).data.map((r) => r.section)
    ).toEqual(['03 30 00', '09 91 00']);
  });

  it('rejects sections + seedFrom together with 422', async () => {
    const res = await req('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: '03 30 00' }],
      seedFrom: 'toc',
    });
    expect(res.status).toBe(422);
  });

  it('422 on a malformed section', async () => {
    const res = await req('PUT', `/projects/${projectId}/required-sections`, {
      sections: [{ section: 'nope' }],
    });
    expect(res.status).toBe(422);
  });

  it('400 on a malformed project id, 404 on unknown project', async () => {
    expect((await req('GET', `/projects/not-a-uuid/required-sections`)).status).toBe(400);
    expect(
      (await req('GET', `/projects/11111111-1111-4111-8111-111111111111/required-sections`)).status
    ).toBe(404);
  });

  it('400 on malformed package id in GET package route', async () => {
    expect(
      (await req('GET', `/projects/${projectId}/packages/not-a-uuid/required-sections`)).status
    ).toBe(400);
  });

  it('404 on valid but unknown package id in PUT package route', async () => {
    expect(
      (
        await req(
          'PUT',
          `/projects/${projectId}/packages/a1b2c3d4-e5f6-4789-abcd-ef0123456789/required-sections`,
          { sections: [{ section: '03 30 00' }] }
        )
      ).status
    ).toBe(404);
  });

  it('404 on valid but unknown project id in PUT baseline route', async () => {
    expect(
      (
        await req('PUT', `/projects/a1b2c3d4-e5f6-4789-abcd-ef0123456789/required-sections`, {
          sections: [{ section: '03 30 00' }],
        })
      ).status
    ).toBe(404);
  });
});
