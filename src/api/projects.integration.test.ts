import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';

async function insertSpec(section: string, title: string, libraryId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3)
     RETURNING id`,
    [section, title, libraryId]
  );
  const row = r.rows[0];
  if (!row) throw new Error(`failed to insert spec ${section}`);
  return row.id;
}

/** Fixture: paragraph carrying an outgoing reference to `targetSection`, plus
 *  the matching spec_references row. Used to model an unresolved cross-section
 *  reference (drives the availableFrom broken-ref advisory). */
async function insertBrokenRefFixture(
  sourceSpecId: string,
  targetSection: string,
  referenceText: string
): Promise<void> {
  const paraRes = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position)
     VALUES ($1, 'article', $2, 1) RETURNING id`,
    [sourceSpecId, referenceText]
  );
  const paraId = paraRes.rows[0]?.id;
  if (!paraId) throw new Error(`failed to insert paragraph fixture for spec ${sourceSpecId}`);
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', $3, $4)`,
    [sourceSpecId, paraId, targetSection, referenceText]
  );
}

async function insertProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const row = r.rows[0];
  if (!row) throw new Error('failed to insert project');
  return row.id;
}

async function postJSON(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getLibraryId(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM libraries WHERE name = $1`, [name]);
  if (!r.rows[0]) throw new Error(`library ${name} missing — run migrations`);
  return r.rows[0].id;
}

let server: Server;
let baseUrl: string;
let testProjectId: string;
let specA: string;
let specB: string;
let companyId: string;
let ufgsId: string;
let companyLibId: string;
const apiProjects: string[] = [];

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
  [companyId, ufgsId] = await Promise.all([
    getLibraryId('Default Company Master'),
    getLibraryId('UFGS Reference'),
  ]);
  companyLibId = companyId;
  [specA, specB] = await Promise.all([
    insertSpec('03 30 00', 'Concrete', companyLibId),
    insertSpec('09 91 00', 'Painting', companyLibId),
  ]);
  testProjectId = await insertProject('Phase 1b Integration Test');
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`,
    [testProjectId, specA, specB]
  );
  // Fixture consumed by sibling describes (e.g. POST /projects/:id/specs
  // 'duplicate section' / '422 when no source holds the section'): specA
  // (03 30 00) has an outgoing ref to 09 91 00, which specB covers in the
  // company master. The availableFrom advisory test below uses its OWN
  // isolated library instead of this shared one — see that describe block.
  await insertBrokenRefFixture(specA, '09 91 00', 'See Section 09 91 00');
});

afterAll(async () => {
  // Cleanup order matters — project_specs.spec_id FK is RESTRICT, so project_specs
  // rows must be removed before their referenced specs can be deleted.
  // Clone specs (project_id = apiProject) also carry parent_spec_id → specA/specB,
  // so clone specs must go before the master specs.
  if (apiProjects.length > 0) {
    await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [apiProjects]);
    await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [apiProjects]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [apiProjects]);
  }
  // testProjectId was inserted via raw SQL — deleting the project cascades its
  // project_specs rows (project_id FK is CASCADE), unblocking specA/specB deletion.
  await pool.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specA, specB]]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /projects', () => {
  let createdId: string;
  afterAll(async () => {
    if (createdId) await pool.query('DELETE FROM projects WHERE id = $1', [createdId]);
  });

  it('returns 201 with ProjectSummary including sources', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Project', sourceLibraryIds: [companyId] }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(201);
    const data = body['data'] as Record<string, unknown>;
    expect(typeof data['projectId']).toBe('string');
    createdId = data['projectId'] as string;
    const sources = data['sources'] as Array<Record<string, unknown>>;
    expect(Array.isArray(sources)).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.['libraryId']).toBe(companyId);
  });

  it('returns 422 for missing name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLibraryIds: [companyId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for empty name', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', sourceLibraryIds: [companyId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when sourceLibraryIds is missing', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 when reference-tier library is used as source', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X', sourceLibraryIds: [ufgsId] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 422 for unknown library id', async () => {
    const res = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        sourceLibraryIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /projects/:id', () => {
  it('returns 200 with toc containing both specs in position order', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    const data = body['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(testProjectId);
    const toc = data['toc'] as Array<Record<string, unknown>>;
    expect(toc.length).toBe(2);
    expect(toc[0]?.['specId']).toBe(specA);
    expect(toc[1]?.['specId']).toBe(specB);
    // testProjectId was inserted via raw SQL (no sources) — field must still be present
    expect(data['sources']).toEqual([]);
  });

  it('returns 404 for unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });
});

describe('GET /projects', () => {
  it('returns 200 listing projects as {id, name}, including the test project, in name order', async () => {
    // Two controlled projects pin the documented name ordering deterministically,
    // without depending on other suites' project names or the DB collation.
    const a = await insertProject('zzz-order-a');
    const b = await insertProject('zzz-order-b');
    apiProjects.push(a, b);

    const res = await fetch(`${baseUrl}/projects`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: Array<{ id: string; name: string }>;
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const mine = body.data.find((p) => p.id === testProjectId);
    expect(mine).toBeDefined();
    expect(mine?.name).toBe('Phase 1b Integration Test');
    for (const p of body.data) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
    }
    // Documented "ordered by name": the controlled subset comes back in order.
    const ordered = body.data.map((p) => p.name).filter((n) => n.startsWith('zzz-order-'));
    expect(ordered).toEqual(['zzz-order-a', 'zzz-order-b']);
  });
});

describe('POST /projects/:id/specs (section-based copy-on-derive)', () => {
  let projectId: string;
  let cloneA: string;

  beforeAll(async () => {
    const res = await postJSON('/projects', {
      name: `Derive API ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const body = (await res.json()) as Record<string, unknown>;
    projectId = (body['data'] as Record<string, unknown>)['projectId'] as string;
    apiProjects.push(projectId);
  });

  it('adds a section: 201 with clone specId (not the master), source, position', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['specId']).not.toBe(specA);
    expect(d['section']).toBe('03 30 00');
    expect(d['position']).toBe(1);
    expect((d['source'] as Record<string, unknown>)['libraryId']).toBe(companyLibId);
    cloneA = d['specId'] as string;
  });

  it('normalizes display-variant section body before cloning into the project', async () => {
    const projectRes = await postJSON('/projects', {
      name: `Derive Display ${Date.now()}`,
      sourceLibraryIds: [companyLibId],
    });
    const projectBody = (await projectRes.json()) as Record<string, unknown>;
    const displayProjectId = (projectBody['data'] as Record<string, unknown>)[
      'projectId'
    ] as string;
    apiProjects.push(displayProjectId);

    const res = await postJSON(`/projects/${displayProjectId}/specs`, { section: '099100' });
    expect(res.status).toBe(201);
    const d = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(d['section']).toBe('09 91 00');
    const stored = await pool.query<{ section: string }>(
      'SELECT section FROM specs WHERE id = $1',
      [d['specId']]
    );
    expect(stored.rows[0]?.section).toBe('09 91 00');
  });

  it('409 on duplicate section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    expect(res.status).toBe(409);
  });

  it('422 when no source holds the section', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { section: '99 99 99' });
    expect(res.status).toBe(422);
  });

  it('422 for malformed section body', async () => {
    const res = await postJSON(`/projects/${projectId}/specs`, { specId: specA });
    expect(res.status).toBe(422);
  });

  it('404 for unknown project', async () => {
    const res = await postJSON(`/projects/00000000-0000-0000-0000-000000000000/specs`, {
      section: '03 30 00',
    });
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await postJSON('/projects/not-a-uuid/specs', { section: '03 30 00' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });

  it('DELETE clean clone returns 200 and deletes the copy, master survives', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const gone = await pool.query('SELECT 1 FROM specs WHERE id = $1', [cloneA]);
    expect(gone.rowCount).toBe(0);
    const master = await pool.query('SELECT 1 FROM specs WHERE id = $1', [specA]);
    expect(master.rowCount).toBe(1);
  });

  it('DELETE edited clone → 409; ?force=true → 200', async () => {
    const add = await postJSON(`/projects/${projectId}/specs`, { section: '03 30 00' });
    const d = ((await add.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    const cloneId = d['specId'] as string;
    await pool.query('UPDATE specs SET content_version = 2 WHERE id = $1', [cloneId]);
    const blocked = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneId}`, {
      method: 'DELETE',
    });
    expect(blocked.status).toBe(409);
    const forced = await fetch(`${baseUrl}/projects/${projectId}/specs/${cloneId}?force=true`, {
      method: 'DELETE',
    });
    expect(forced.status).toBe(200);
  });

  it('DELETE returns 404 when spec not owned by project', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/${specA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('DELETE 400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/specs/${specA}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });

  it('DELETE 400 — malformed (non-UUID) spec id (#568)', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs/not-a-uuid`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid spec id' });
  });
});

describe('GET /projects/:id/references/broken — availableFrom advisory', () => {
  // Root cause (#522): resolveSection's tie-break (src/db/queries/derive.ts,
  // `ORDER BY ps.priority, s.created_at, s.id`) has no dedup guard on
  // (library_id, section) and deterministically picks the OLDEST matching spec
  // row. Against a freshly migrated+seeded DB this is a non-issue — but a dev
  // DB that has previously run this suite (or crashed mid-run) can carry a
  // leftover, older '03 30 00' spec in the shared, name-looked-up 'Default
  // Company Master' library. That older row shadows this describe block's own
  // freshly-inserted master, so the clone made from POST .../specs carries
  // none of THIS fixture's outgoing references — the broken-ref list comes
  // back empty and `.find(...)` yields undefined. Fix: give this describe
  // block its own uniquely-named library, so its fixtures can never be
  // shadowed by ambient rows in the shared company master.
  let advisoryLibId: string;
  let advisoryMasterId: string;
  let advisoryTargetId: string;
  // Set inside the test — its clone (parent_spec_id -> advisoryMasterId) must
  // be torn down before the master specs, ahead of the module-level apiProjects
  // cleanup (which runs after every describe block's own afterAll).
  let advisoryProjectId: string | undefined;

  beforeAll(async () => {
    const lib = await createLibrary({ tier: 'company', name: `Advisory Master ${Date.now()}` });
    advisoryLibId = lib.id;
    [advisoryMasterId, advisoryTargetId] = await Promise.all([
      insertSpec('03 30 00', 'Advisory Concrete', advisoryLibId),
      insertSpec('09 91 00', 'Advisory Painting', advisoryLibId),
    ]);
    await insertBrokenRefFixture(advisoryMasterId, '09 91 00', 'See Section 09 91 00');
  });

  afterAll(async () => {
    // The clone made by POST .../specs (project_id = advisoryProjectId,
    // parent_spec_id -> advisoryMasterId) is FK-RESTRICT on its parent — it
    // must go before the master specs, so this can't wait for the
    // module-level apiProjects cleanup at the bottom of the file.
    if (advisoryProjectId) {
      await pool.query('DELETE FROM project_specs WHERE project_id = $1', [advisoryProjectId]);
      await pool.query('DELETE FROM specs WHERE project_id = $1', [advisoryProjectId]);
    }
    await pool.query('DELETE FROM specs WHERE id = ANY($1)', [
      [advisoryMasterId, advisoryTargetId],
    ]);
    // project_sources.library_id is FK-RESTRICT too — same reasoning as the
    // 'PUT /projects/:id/sources' describe block below.
    await pool.query('DELETE FROM project_sources WHERE library_id = $1', [advisoryLibId]);
    await pool.query('DELETE FROM libraries WHERE id = $1', [advisoryLibId]);
  });

  it('broken ref lists the source libraries that hold the missing section (isolated fixture library — immune to ambient/duplicate 03 30 00 rows in the shared Default Company Master, #522)', async () => {
    const created = await postJSON('/projects', {
      name: `Advisory ${Date.now()}`,
      sourceLibraryIds: [advisoryLibId],
    });
    const pid = (
      ((await created.json()) as Record<string, unknown>)['data'] as Record<string, unknown>
    )['projectId'] as string;
    advisoryProjectId = pid;
    apiProjects.push(pid);
    // Clone 03 30 00 — advisoryMasterId has an outgoing ref to 09 91 00
    // (advisoryTargetId, in the same dedicated library). Since 09 91 00 is not
    // yet in the project, the clone ref is is_broken=true; availableFrom
    // should name the dedicated advisory library.
    await postJSON(`/projects/${pid}/specs`, { section: '03 30 00' });
    const res = await fetch(`${baseUrl}/projects/${pid}/references/broken`);
    expect(res.status).toBe(200);
    const refs = ((await res.json()) as Record<string, unknown>)['data'] as Array<
      Record<string, unknown>
    >;
    const ref = refs.find((r) => r['targetSpecSection'] === '09 91 00');
    expect(ref).toBeDefined();
    expect(ref?.['availableFrom']).toEqual([expect.objectContaining({ libraryId: advisoryLibId })]);
  });

  it('400 — malformed (non-UUID) project id (#568)', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/references/broken`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });
});

describe('PUT /projects/:id/sources', () => {
  let pid: string;
  let clientLibId: string;

  beforeAll(async () => {
    const created = await postJSON('/projects', {
      name: `Sources ${Date.now()}`,
      sourceLibraryIds: [companyId],
    });
    pid = (((await created.json()) as Record<string, unknown>)['data'] as Record<string, unknown>)[
      'projectId'
    ] as string;
    apiProjects.push(pid);
    const lib = await createLibrary({ tier: 'client', name: `sources-api-${Date.now()}` });
    clientLibId = lib.id;
  });

  afterAll(async () => {
    // The client lib is FK-referenced by project_sources (RESTRICT) — clear those
    // rows before deleting it. The project itself is cleaned by the top-level afterAll.
    await pool.query('DELETE FROM project_sources WHERE library_id = $1', [clientLibId]);
    await pool.query('DELETE FROM libraries WHERE id = $1', [clientLibId]);
  });

  async function putSources(projectId: string, ids: string[]): Promise<Response> {
    return fetch(`${baseUrl}/projects/${projectId}/sources`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLibraryIds: ids }),
    });
  }

  it('200 — replaces the ordered source list and persists it', async () => {
    const res = await putSources(pid, [clientLibId, companyId]);
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Record<string, unknown>)['data'] as {
      projectId: string;
      sources: Array<{ libraryId: string; priority: number }>;
    };
    expect(data.projectId).toBe(pid);
    expect(data.sources.map((s) => s.libraryId)).toEqual([clientLibId, companyId]);
    expect(data.sources.map((s) => s.priority)).toEqual([1, 2]);
    // Persisted: GET /projects/:id reflects the new order.
    const proj = await fetch(`${baseUrl}/projects/${pid}`);
    const sources = (
      ((await proj.json()) as Record<string, unknown>)['data'] as {
        sources: Array<{ libraryId: string }>;
      }
    ).sources;
    expect(sources.map((s) => s.libraryId)).toEqual([clientLibId, companyId]);
  });

  it('404 — unknown project', async () => {
    const res = await putSources('00000000-0000-0000-0000-000000000000', [companyId]);
    expect(res.status).toBe(404);
  });

  it('422 — reference-tier source rejected', async () => {
    const res = await putSources(pid, [ufgsId]);
    expect(res.status).toBe(422);
  });

  it('400 — empty sourceLibraryIds', async () => {
    const res = await putSources(pid, []);
    expect(res.status).toBe(400);
  });

  it('400 — duplicate sourceLibraryIds', async () => {
    const res = await putSources(pid, [companyId, companyId]);
    expect(res.status).toBe(400);
  });

  it('400 — malformed project id (not a UUID)', async () => {
    const res = await putSources('not-a-uuid', [companyId]);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });
});

describe('DELETE /projects/:id (soft-delete) + POST /projects/:id/restore', () => {
  async function freshProject(): Promise<string> {
    const id = await insertProject(`soft-delete ${randomUUID()}`);
    apiProjects.push(id);
    return id;
  }

  async function deleteProject(id: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/projects/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('soft-deletes: 200 with {projectId, deletedAt, deletedBy}, hidden from list, still GET-able', async () => {
    const id = await freshProject();
    const res = await deleteProject(id, { deletedBy: 'alice@firm.example' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(id);
    expect(typeof data['deletedAt']).toBe('string');
    expect(data['deletedBy']).toBe('alice@firm.example');

    // Disappears from GET /projects.
    const list = await fetch(`${baseUrl}/projects`);
    const listBody = (await list.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.find((p) => p.id === id)).toBeUndefined();

    // Still GET-able by id, with the tombstone surfaced.
    const got = await fetch(`${baseUrl}/projects/${id}`);
    expect(got.status).toBe(200);
    const proj = ((await got.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(proj['projectId']).toBe(id);
    expect(proj['deletedAt']).toBe(data['deletedAt']);
    expect(proj['deletedBy']).toBe('alice@firm.example');
  });

  it('restore: 200 + reappears in GET /projects, tombstone cleared on GET /projects/:id', async () => {
    const id = await freshProject();
    await deleteProject(id, { deletedBy: 'bob' });

    const res = await fetch(`${baseUrl}/projects/${id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(id);

    const list = await fetch(`${baseUrl}/projects`);
    const listBody = (await list.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.find((p) => p.id === id)).toBeDefined();

    const got = await fetch(`${baseUrl}/projects/${id}`);
    const proj = ((await got.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(proj['deletedAt']).toBeNull();
    expect(proj['deletedBy']).toBeNull();
  });

  it('active project surfaces deletedAt/deletedBy as null on GET /projects/:id', async () => {
    const id = await freshProject();
    const got = await fetch(`${baseUrl}/projects/${id}`);
    const proj = ((await got.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(proj['deletedAt']).toBeNull();
    expect(proj['deletedBy']).toBeNull();
  });

  it('re-delete is idempotent: returns the original deletedAt/deletedBy unchanged', async () => {
    const id = await freshProject();
    const first = await deleteProject(id, { deletedBy: 'first-actor' });
    const firstData = ((await first.json()) as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;

    // A second delete by a different actor must NOT overwrite the original tombstone.
    const second = await deleteProject(id, { deletedBy: 'second-actor' });
    expect(second.status).toBe(200);
    const secondData = ((await second.json()) as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    expect(secondData['deletedAt']).toBe(firstData['deletedAt']);
    expect(secondData['deletedBy']).toBe('first-actor');
  });

  it('restore is idempotent on a non-deleted project: 200', async () => {
    const id = await freshProject();
    const res = await fetch(`${baseUrl}/projects/${id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(data['projectId']).toBe(id);
  });

  it('400 — missing deletedBy', async () => {
    const id = await freshProject();
    const res = await deleteProject(id, {});
    expect(res.status).toBe(400);
  });

  it('400 — empty deletedBy', async () => {
    const id = await freshProject();
    const res = await deleteProject(id, { deletedBy: '' });
    expect(res.status).toBe(400);
  });

  it('400 — malformed (non-UUID) project id on delete', async () => {
    const res = await deleteProject('not-a-uuid', { deletedBy: 'alice' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });

  it('404 — delete unknown project', async () => {
    const res = await deleteProject(randomUUID(), { deletedBy: 'alice' });
    expect(res.status).toBe(404);
  });

  it('400 — malformed (non-UUID) project id on restore', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/restore`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });

  it('404 — restore unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/${randomUUID()}/restore`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /projects/:id', () => {
  it('renames a project', async () => {
    const createRes = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Original Name', sourceLibraryIds: [companyId] }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const data = created['data'] as Record<string, unknown>;
    const id = (data['projectId'] ?? data['id']) as string;
    apiProjects.push(id);

    const res = await fetch(`${baseUrl}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Project' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['success']).toBe(true);
    const bodyData = body['data'] as Record<string, unknown>;
    expect(bodyData).toMatchObject({ projectId: id, name: 'Renamed Project' });
  });

  it('404s an unknown project', async () => {
    const res = await fetch(`${baseUrl}/projects/${randomUUID()}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s a malformed (non-UUID) project id', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'invalid project id' });
  });

  it('400s an empty name', async () => {
    const createRes = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P', sourceLibraryIds: [companyId] }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const data = created['data'] as Record<string, unknown>;
    const id = (data['projectId'] ?? data['id']) as string;
    apiProjects.push(id);
    const res = await fetch(`${baseUrl}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('persists sectionNumberFormat and GET /projects/:id returns it', async () => {
    const createRes = await fetch(`${baseUrl}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Format Test', sourceLibraryIds: [companyId] }),
    });
    const created = (await createRes.json()) as Record<string, unknown>;
    const data = created['data'] as Record<string, unknown>;
    const id = (data['projectId'] ?? data['id']) as string;
    apiProjects.push(id);

    const patchRes = await fetch(`${baseUrl}/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectionNumberFormat: 'spaced-compact' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as Record<string, unknown>;
    const patchData = patchBody['data'] as Record<string, unknown>;
    expect(patchData['sectionNumberFormat']).toBe('spaced-compact');

    const getRes = await fetch(`${baseUrl}/projects/${id}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as Record<string, unknown>;
    const getData = getBody['data'] as Record<string, unknown>;
    expect(getData['sectionNumberFormat']).toBe('spaced-compact');
  });

  it('400s when neither name nor sectionNumberFormat is provided', async () => {
    const res = await fetch(`${baseUrl}/projects/${testProjectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
