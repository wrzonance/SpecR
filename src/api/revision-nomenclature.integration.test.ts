import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

const ZERO = '00000000-0000-4000-8000-000000000000';

let server: Server;
let baseUrl: string;
let counter = 0;

interface NomenclatureType {
  readonly key: string;
  readonly name?: string;
  readonly format?: { readonly displayName?: string; readonly number?: string };
  readonly fields?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

interface NomenclatureProfile {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly types: readonly NomenclatureType[];
}

interface RevisionData {
  readonly revisionId: string;
  readonly packageId: string;
  readonly label: string;
  readonly displayName: string;
  readonly type: string;
  readonly date: string;
  readonly sortOrder: number;
  readonly number: string | null;
  readonly attributes: Record<string, unknown>;
  readonly specCount?: number;
  readonly specs?: readonly unknown[];
}

interface OkData<T> {
  readonly success: true;
  readonly data: T;
  readonly meta?: { readonly inherited: boolean };
}

async function request(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function data<T>(res: Response): Promise<T> {
  return ((await res.json()) as OkData<T>).data;
}

async function makeProject(): Promise<string> {
  counter += 1;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`nomen-api-${Date.now()}-${counter}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('makeProject: no project id returned');
  return row.id;
}

async function makePackage(projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position)
     VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `Nomenclature Package ${counter}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('makePackage: no package id returned');
  return row.id;
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

afterEach(async () => {
  await pool.query(`DELETE FROM projects WHERE name LIKE 'nomen-api-%'`);
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('revision nomenclature profile API', () => {
  it('lists the built-in default profile with issuance/addendum/bulletin/CCD types', async () => {
    const res = await request('GET', '/revision-nomenclature-profiles');
    expect(res.status).toBe(200);
    const profiles = await data<NomenclatureProfile[]>(res);
    const builtIn = profiles.find((profile) => profile.projectId === null);
    expect(builtIn?.name).toBe('SpecR Default Revision Nomenclature');
    expect(builtIn?.types.map((type) => type.key)).toEqual([
      'issuance',
      'addendum',
      'bulletin',
      'ccd',
    ]);
    expect(builtIn?.types.find((type) => type.key === 'addendum')?.format).toMatchObject({
      displayName: 'Addendum {number}',
      number: '{number}',
    });
  });

  it('falls back to the built-in profile for a project with no override', async () => {
    const projectId = await makeProject();
    const res = await request('GET', `/projects/${projectId}/revision-nomenclature`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkData<NomenclatureProfile>;
    expect(body.meta?.inherited).toBe(true);
    expect(body.data.projectId).toBeNull();
  });

  it('creates, replaces, and deletes a project override while preserving open type keys', async () => {
    const projectId = await makeProject();
    const body = {
      name: 'Acme Revision Names',
      types: [
        {
          key: 'addendum',
          name: 'Architect Addendum',
          format: { displayName: 'ADD-{number}: {title}', number: 'ADD-{number}' },
          fields: [
            { key: 'number', kind: 'integer', required: true, sequence: 'per-package' },
            { key: 'title', kind: 'string' },
          ],
          dashboardColor: 'blue',
        },
      ],
    };

    const put = await request('PUT', `/projects/${projectId}/revision-nomenclature`, body);
    expect(put.status).toBe(200);
    const created = await data<NomenclatureProfile>(put);
    expect(created.projectId).toBe(projectId);
    expect(created.types).toEqual(body.types);

    const replaced = await request('PUT', `/projects/${projectId}/revision-nomenclature`, {
      name: 'Acme Updated',
      types: [{ key: 'bulletin', format: { displayName: 'Bulletin {number}' } }],
    });
    expect(replaced.status).toBe(200);
    const updated = await data<NomenclatureProfile>(replaced);
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Acme Updated');
    expect(updated.types.map((type) => type.key)).toEqual(['bulletin']);

    const deleted = await request('DELETE', `/projects/${projectId}/revision-nomenclature`);
    expect(deleted.status).toBe(200);

    const fallback = await request('GET', `/projects/${projectId}/revision-nomenclature`);
    const fallbackBody = (await fallback.json()) as OkData<NomenclatureProfile>;
    expect(fallbackBody.meta?.inherited).toBe(true);
  });

  it('clones the built-in profile into a project override', async () => {
    const profiles = await data<NomenclatureProfile[]>(
      await request('GET', '/revision-nomenclature-profiles')
    );
    const builtIn = profiles.find((profile) => profile.projectId === null);
    const projectId = await makeProject();

    const res = await request('POST', `/projects/${projectId}/revision-nomenclature/clone`, {
      sourceId: builtIn?.id,
    });

    expect(res.status).toBe(201);
    const cloned = await data<NomenclatureProfile>(res);
    expect(cloned.projectId).toBe(projectId);
    expect(cloned.types).toEqual(builtIn?.types);
  });

  it('404s for an unknown project and 400s for a malformed project id', async () => {
    expect((await request('GET', `/projects/${ZERO}/revision-nomenclature`)).status).toBe(404);
    expect((await request('GET', '/projects/not-a-uuid/revision-nomenclature')).status).toBe(400);
  });
});

describe('package revision nomenclature', () => {
  it('creates and reads a structured revision using the project profile display templates', async () => {
    const projectId = await makeProject();
    const packageId = await makePackage(projectId);
    await request('PUT', `/projects/${projectId}/revision-nomenclature`, {
      name: 'Acme Revision Names',
      types: [
        {
          key: 'addendum',
          format: { displayName: 'ADD-{number}: {title}', number: 'ADD-{number}' },
          fields: [
            { key: 'number', kind: 'integer', required: true },
            { key: 'title', kind: 'string', required: true },
          ],
        },
      ],
    });

    const created = await request('POST', `/packages/${packageId}/revisions`, {
      type: 'addendum',
      date: '2026-06-18',
      attributes: {
        number: 7,
        title: 'Glazing updates',
        headerFooterSignal: { source: 'future' },
      },
    });

    expect(created.status).toBe(201);
    const summary = await data<RevisionData>(created);
    expect(summary).toMatchObject({
      packageId,
      label: 'ADD-7: Glazing updates',
      displayName: 'ADD-7: Glazing updates',
      type: 'addendum',
      date: '2026-06-18',
      sortOrder: 1,
      number: 'ADD-7',
      specCount: 0,
    });
    expect(summary.attributes).toEqual({
      number: 7,
      title: 'Glazing updates',
      headerFooterSignal: { source: 'future' },
    });

    const read = await request('GET', `/revisions/${summary.revisionId}`);
    expect(read.status).toBe(200);
    const full = await data<RevisionData>(read);
    expect(full.displayName).toBe('ADD-7: Glazing updates');
    expect(full.number).toBe('ADD-7');
    expect(full.attributes).toEqual(summary.attributes);
    expect(full.specs).toEqual([]);
  });

  it('keeps the legacy label-only issuance flow working with derived type and attributes', async () => {
    const projectId = await makeProject();
    const packageId = await makePackage(projectId);
    const res = await request('POST', `/packages/${packageId}/revisions`, { label: 'Addendum 3' });

    expect(res.status).toBe(201);
    const summary = await data<RevisionData>(res);
    expect(summary).toMatchObject({
      label: 'Addendum 3',
      displayName: 'Addendum 3',
      type: 'addendum',
      sortOrder: 1,
      number: '3',
      attributes: { number: 3 },
    });
  });

  it('rejects an explicit revision type missing from the resolved profile', async () => {
    const projectId = await makeProject();
    const packageId = await makePackage(projectId);
    const res = await request('POST', `/packages/${packageId}/revisions`, {
      type: 'asi',
      attributes: { number: 1 },
    });

    expect(res.status).toBe(422);
  });

  it('rejects invalid calendar dates before the database insert', async () => {
    const projectId = await makeProject();
    const packageId = await makePackage(projectId);
    const res = await request('POST', `/packages/${packageId}/revisions`, {
      type: 'addendum',
      date: '2026-99-99',
      attributes: { number: 1 },
    });

    expect(res.status).toBe(422);
  });

  it('rejects mixed legacy and structured revision payloads', async () => {
    const projectId = await makeProject();
    const packageId = await makePackage(projectId);
    const res = await request('POST', `/packages/${packageId}/revisions`, {
      label: 'Addendum 99',
      type: 'addendum',
      date: '2026-06-18',
      attributes: { number: 99 },
    });

    expect(res.status).toBe(422);
  });
});
