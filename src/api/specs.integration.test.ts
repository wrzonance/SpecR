import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
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

  it('normalizes a display-variant section override before update', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ section: '27.21.00' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect((body['data'] as Record<string, unknown>)['section']).toBe('27 21 00');
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

describe('DELETE /specs/:id (withdraw) + POST /specs/:id/restore (ADR-030, integration)', () => {
  const masterIds: string[] = [];
  const copySpecIds: string[] = [];
  const projectIds: string[] = [];
  const libraryIds: string[] = [];

  async function createLibrary(): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
      [`withdraw-test ${randomUUID()}`]
    );
    const row = res.rows[0];
    if (!row) throw new Error('failed to create test library');
    libraryIds.push(row.id);
    return row.id;
  }

  async function createMaster(libraryId: string, section: string): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ($1, $2, 'ufgs', $3) RETURNING id`,
      [section, `Master ${section}`, libraryId]
    );
    const row = res.rows[0];
    if (!row) throw new Error('failed to create test master');
    masterIds.push(row.id);
    return row.id;
  }

  async function createProject(label: string): Promise<string> {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`${label} ${randomUUID()}`]
    );
    const row = res.rows[0];
    if (!row) throw new Error('failed to create test project');
    projectIds.push(row.id);
    return row.id;
  }

  // A project copy is a spec with project_id set (library_id NULL) and
  // parent_spec_id pointing back at its master (the copy model, ADR-015/030).
  async function createProjectCopy(section: string): Promise<string> {
    const projectId = await createProject('withdraw-copy');
    const master = await createMaster(await createLibrary(), section);
    const res = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id, parent_spec_id, content_version)
       VALUES ($1, $2, 'ufgs', $3, $4, 1) RETURNING id`,
      [section, `Copy ${section}`, projectId, master]
    );
    const row = res.rows[0];
    if (!row) throw new Error('failed to create test project copy');
    copySpecIds.push(row.id);
    return row.id;
  }

  afterAll(async () => {
    // Membership rows pin the copies (FK is RESTRICT) — clear them first.
    if (projectIds.length) {
      await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1::uuid[])', [
        projectIds,
      ]);
    }
    if (copySpecIds.length) {
      await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [copySpecIds]);
    }
    if (projectIds.length) {
      await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1::uuid[])', [
        projectIds,
      ]);
      await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projectIds]);
    }
    if (masterIds.length) {
      await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [masterIds]);
    }
    if (libraryIds.length) {
      await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [libraryIds]);
    }
  });

  function withdraw(id: string): Promise<Response> {
    return fetch(`${baseUrl}/specs/${id}`, { method: 'DELETE' });
  }
  function restore(id: string): Promise<Response> {
    return fetch(`${baseUrl}/specs/${id}/restore`, { method: 'POST' });
  }
  async function dataOf(res: Response): Promise<Record<string, unknown>> {
    return ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
  }
  async function listSpecIds(libraryId: string): Promise<string[]> {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/specs`);
    const body = (await res.json()) as { data: Array<{ specId: string }> };
    return body.data.map((s) => s.specId);
  }

  it('withdraws a master: 200 {specId, withdrawnAt}, hidden from listing, still GET-able', async () => {
    const lib = await createLibrary();
    const id = await createMaster(lib, '99 01 00');
    expect(await listSpecIds(lib)).toContain(id);

    const res = await withdraw(id);
    expect(res.status).toBe(200);
    const data = await dataOf(res);
    expect(data['specId']).toBe(id);
    expect(typeof data['withdrawnAt']).toBe('string');

    // Hidden from the library listing (listLibrarySpecs filters withdrawn_at).
    expect(await listSpecIds(lib)).not.toContain(id);

    // Still GET-able by id, with withdrawnAt surfaced (lineage/history resolves).
    const got = await fetch(`${baseUrl}/specs/${id}`);
    expect(got.status).toBe(200);
    expect((await dataOf(got))['withdrawnAt']).toBe(data['withdrawnAt']);
  });

  it('active master surfaces withdrawnAt: null on GET /specs/:id', async () => {
    const id = await createMaster(await createLibrary(), '99 02 00');
    const got = await fetch(`${baseUrl}/specs/${id}`);
    expect((await dataOf(got))['withdrawnAt']).toBeNull();
  });

  it('re-withdraw is idempotent: returns the original withdrawnAt unchanged', async () => {
    const id = await createMaster(await createLibrary(), '99 03 00');
    const first = await dataOf(await withdraw(id));
    const second = await withdraw(id);
    expect(second.status).toBe(200);
    expect((await dataOf(second))['withdrawnAt']).toBe(first['withdrawnAt']);
  });

  it('restore: 200, reappears in listing, withdrawnAt cleared on GET', async () => {
    const lib = await createLibrary();
    const id = await createMaster(lib, '99 04 00');
    await withdraw(id);

    const res = await restore(id);
    expect(res.status).toBe(200);
    expect((await dataOf(res))['specId']).toBe(id);

    expect(await listSpecIds(lib)).toContain(id);
    const got = await fetch(`${baseUrl}/specs/${id}`);
    expect((await dataOf(got))['withdrawnAt']).toBeNull();
  });

  it('restore is idempotent on a non-withdrawn master: 200', async () => {
    const id = await createMaster(await createLibrary(), '99 05 00');
    expect((await restore(id)).status).toBe(200);
  });

  it('409 — withdraw a project copy steers to the membership endpoint', async () => {
    const copyId = await createProjectCopy('99 06 00');
    const res = await withdraw(copyId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['success']).toBe(false);
    expect(String(body['error'])).toContain('project copy');
  });

  it('409 — restore a project copy (withdrawal applies to masters)', async () => {
    const copyId = await createProjectCopy('99 07 00');
    expect((await restore(copyId)).status).toBe(409);
  });

  it('project source resolution hides a withdrawn master, resolves again after restore', async () => {
    const lib = await createLibrary();
    const id = await createMaster(lib, '99 08 00');
    const projectId = await createProject('withdraw-resolve');
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
      [projectId, lib]
    );

    await withdraw(id);
    const derive = (): Promise<Response> =>
      fetch(`${baseUrl}/projects/${projectId}/specs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: '99 08 00' }),
      });

    // The only holder of 99 08 00 is withdrawn → unresolved (422).
    expect((await derive()).status).toBe(422);

    // After restore the section resolves and clones into the project (201).
    await restore(id);
    const ok = await derive();
    expect(ok.status).toBe(201);
    const created = await dataOf(ok);
    if (typeof created['specId'] === 'string') copySpecIds.push(created['specId']);
  });

  it('404 — withdraw unknown spec', async () => {
    expect((await withdraw(randomUUID())).status).toBe(404);
  });

  it('404 — restore unknown spec', async () => {
    expect((await restore(randomUUID())).status).toBe(404);
  });

  it('400 — malformed (non-UUID) spec id on withdraw', async () => {
    expect((await withdraw('not-a-uuid')).status).toBe(400);
  });

  it('400 — malformed (non-UUID) spec id on restore', async () => {
    expect((await restore('not-a-uuid')).status).toBe(400);
  });
});
