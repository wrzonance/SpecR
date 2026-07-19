import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;
let companyLibId: string;

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

// Reserved namespace: every client + project named 'api-client-%'. FK-safe cleanup —
// projects first (cascades project_sources, releases the RESTRICT), then clients.
async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM projects WHERE name LIKE 'api-client-%'`);
  await pool.query(`DELETE FROM clients WHERE name LIKE 'api-client-%'`);
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
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  if (!lib.rows[0]) throw new Error('default company library missing — run migrations');
  companyLibId = lib.rows[0].id;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('POST /clients', () => {
  it('creates a client and returns the ClientSummary (201)', async () => {
    const res = await req('POST', '/clients', { name: 'api-client-create' });
    expect(res.status).toBe(201);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data).toMatchObject({ name: 'api-client-create', libraryId: null });
    expect(data['sectionNumberFormat']).toBe('canonical');
    expect(typeof data['id']).toBe('string');
    expect(typeof data['createdAt']).toBe('string');
    expect(typeof data['updatedAt']).toBe('string');
  });

  it('creates a client with a firm section-number default', async () => {
    const res = await req('POST', '/clients', {
      name: 'api-client-format-create',
      sectionNumberFormat: 'compact',
    });
    expect(res.status).toBe(201);
    expect(((await json(res))['data'] as Record<string, unknown>)['sectionNumberFormat']).toBe(
      'compact'
    );
  });

  it('rejects a duplicate name with 409', async () => {
    await req('POST', '/clients', { name: 'api-client-dup' });
    const res = await req('POST', '/clients', { name: 'api-client-dup' });
    expect(res.status).toBe(409);
  });

  it('rejects a missing name with 400', async () => {
    const res = await req('POST', '/clients', { libraryId: companyLibId });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown libraryId with 422', async () => {
    const res = await req('POST', '/clients', {
      name: 'api-client-badlib',
      libraryId: randomUUID(),
    });
    expect(res.status).toBe(422);
  });

  it('links a real libraryId', async () => {
    const res = await req('POST', '/clients', {
      name: 'api-client-linked',
      libraryId: companyLibId,
    });
    expect(res.status).toBe(201);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data['libraryId']).toBe(companyLibId);
  });
});

describe('PATCH /clients/:id', () => {
  it('updates the firm section-number default and read endpoints expose it', async () => {
    const created = (
      await json(await req('POST', '/clients', { name: 'api-client-format-update' }))
    )['data'] as { id: string };
    const patch = await req('PATCH', `/clients/${created.id}`, {
      sectionNumberFormat: 'spaced-compact',
    });
    expect(patch.status).toBe(200);
    expect(((await json(patch))['data'] as Record<string, unknown>)['sectionNumberFormat']).toBe(
      'spaced-compact'
    );

    const detail = (await json(await req('GET', `/clients/${created.id}`)))['data'] as Record<
      string,
      unknown
    >;
    expect(detail['sectionNumberFormat']).toBe('spaced-compact');
  });

  it('rejects an invalid format and returns 404 for an unknown client', async () => {
    const invalid = await req('PATCH', `/clients/${randomUUID()}`, {
      sectionNumberFormat: 'slashes',
    });
    expect(invalid.status).toBe(400);
    const missing = await req('PATCH', `/clients/${randomUUID()}`, {
      sectionNumberFormat: 'dots',
    });
    expect(missing.status).toBe(404);
  });
});

describe('GET /clients', () => {
  it('lists created clients', async () => {
    await req('POST', '/clients', { name: 'api-client-list' });
    const res = await req('GET', '/clients');
    expect(res.status).toBe(200);
    const data = (await json(res))['data'] as { name: string }[];
    expect(data.map((c) => c.name)).toContain('api-client-list');
  });
});

describe('GET /clients/:id', () => {
  it('400s on a malformed id', async () => {
    const res = await req('GET', '/clients/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('404s on an unknown id', async () => {
    const res = await req('GET', `/clients/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('returns the client with an empty projects list when unassociated', async () => {
    const created = (await json(await req('POST', '/clients', { name: 'api-client-empty' })))[
      'data'
    ] as { id: string };
    const res = await req('GET', `/clients/${created.id}`);
    expect(res.status).toBe(200);
    const data = (await json(res))['data'] as Record<string, unknown>;
    expect(data['projects']).toEqual([]);
  });
});

describe('PATCH /projects/:id client association', () => {
  async function makeProject(name: string): Promise<string> {
    const res = await req('POST', '/projects', { name, sourceLibraryIds: [companyLibId] });
    return ((await json(res))['data'] as { projectId: string }).projectId;
  }
  async function makeClient(name: string): Promise<string> {
    const res = await req('POST', '/clients', { name });
    return ((await json(res))['data'] as { id: string }).id;
  }

  it('associates a project, echoes clientId, and surfaces it under the client', async () => {
    const projectId = await makeProject('api-client-assoc-project');
    const clientId = await makeClient('api-client-assoc-owner');

    const patch = await req('PATCH', `/projects/${projectId}`, { clientId });
    expect(patch.status).toBe(200);
    expect((await json(patch))['data']).toMatchObject({ projectId, clientId });

    const detail = (await json(await req('GET', `/clients/${clientId}`)))['data'] as {
      projects: { projectId: string; clientName: string }[];
    };
    expect(detail.projects.map((p) => p.projectId)).toContain(projectId);
    expect(detail.projects[0]?.clientName).toBe('api-client-assoc-owner');
  });

  it('disassociates on clientId null', async () => {
    const projectId = await makeProject('api-client-disassoc-project');
    const clientId = await makeClient('api-client-disassoc-owner');
    await req('PATCH', `/projects/${projectId}`, { clientId });

    const patch = await req('PATCH', `/projects/${projectId}`, { clientId: null });
    expect(patch.status).toBe(200);
    expect((await json(patch))['data']).toMatchObject({ projectId, clientId: null });

    const detail = (await json(await req('GET', `/clients/${clientId}`)))['data'] as {
      projects: unknown[];
    };
    expect(detail.projects).toEqual([]);
  });

  it('422s when associating an unknown client', async () => {
    const projectId = await makeProject('api-client-unknown-project');
    const res = await req('PATCH', `/projects/${projectId}`, { clientId: randomUUID() });
    expect(res.status).toBe(422);
  });

  it('resolves project override, then firm default, and allows clearing the override', async () => {
    const projectId = await makeProject('api-client-format-project');
    const clientRes = await req('POST', '/clients', {
      name: 'api-client-format-owner',
      sectionNumberFormat: 'dots',
    });
    const clientId = ((await json(clientRes))['data'] as { id: string }).id;

    const inherited = await req('PATCH', `/projects/${projectId}`, { clientId });
    expect(
      ((await json(inherited))['data'] as Record<string, unknown>)['sectionNumberFormat']
    ).toBe('dots');

    const explicit = await req('PATCH', `/projects/${projectId}`, {
      sectionNumberFormat: 'compact',
    });
    expect(((await json(explicit))['data'] as Record<string, unknown>)['sectionNumberFormat']).toBe(
      'compact'
    );

    const cleared = await req('PATCH', `/projects/${projectId}`, { sectionNumberFormat: null });
    expect(((await json(cleared))['data'] as Record<string, unknown>)['sectionNumberFormat']).toBe(
      'dots'
    );
  });
});
