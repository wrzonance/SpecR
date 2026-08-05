import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import {
  resolvePackageHeaderFooterHandler,
  resolveProjectHeaderFooterHandler,
  resolveRevisionHeaderFooterHandler,
} from './header-footer-resolve.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, upsertHeaderFooterConfig } from '../db/index.js';
import type { ResolvedHeaderFooterConfig } from '../db/index.js';

// ─── Test setup ────────────────────────────────────────────────────────────
//
// Isolated app: registers only the effective-resolution routes this task
// owns (mirrors the wiring router.ts will carry once it is wired in, but
// does not depend on router.ts itself, since that wiring is a later task).

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/projects/:id/header-footer/resolved', resolveProjectHeaderFooterHandler);
  app.get('/packages/:id/header-footer/resolved', resolvePackageHeaderFooterHandler);
  app.get('/revisions/:id/header-footer/resolved', resolveRevisionHeaderFooterHandler);

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
  await pool.end();
});

const TEST_PREFIX = 'hf-resolve-';

// A monotonic counter (not Date.now() alone) keeps fixture names unique even
// when several fixtures are created within the same millisecond.
let fixtureCounter = 0;
function uniqueSuffix(): string {
  fixtureCounter += 1;
  return `${Date.now()}-${fixtureCounter}`;
}

async function insertProject(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`${TEST_PREFIX}project-${uniqueSuffix()}`, 'header/footer resolve API test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProject: no project id returned');
  return row.id;
}

async function insertPackage(projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position)
     VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${TEST_PREFIX}package-${uniqueSuffix()}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertPackage: no package id returned');
  return row.id;
}

async function insertRevision(packageId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO package_revisions
       (package_id, label, revision_type, revision_date, sort_order, attributes)
     VALUES ($1, 'Addendum 1', 'addendum', '2026-06-18'::date, 1, '{"number":1}'::jsonb)
     RETURNING id`,
    [packageId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertRevision: no revision id returned');
  return row.id;
}

async function attachClientSource(projectId: string, libraryId: string): Promise<void> {
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, libraryId]
  );
}

afterEach(async () => {
  // No explicit `header_footer_configs` delete: that table's `scope_xor` CHECK
  // forces exactly ONE of client_library_id/project_id/package_id/revision_id
  // to be non-null, and all four FKs are `ON DELETE CASCADE` — so every row
  // this file creates is necessarily owned by, and removed with, one of the
  // rows deleted below. A whole-table wipe here would also destroy a
  // concurrent invocation's rows (#638/ADR-090) for no benefit (#442).
  await pool.query(
    `DELETE FROM project_sources
     WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(
    `DELETE FROM package_revisions
     WHERE package_id IN (SELECT id FROM design_packages WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM design_packages WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

interface ResolveEnvelope {
  readonly success: true;
  readonly data: ResolvedHeaderFooterConfig;
}

// ─── Invariant: 404 when the anchor id itself does not exist ──────────────

describe('GET .../header-footer/resolved — nonexistent anchor', () => {
  it('404 for a nonexistent project id', async () => {
    const res = await get(`/projects/${MISSING_UUID}/header-footer/resolved`);
    expect(res.status).toBe(404);
  });

  it('404 for a nonexistent package id', async () => {
    const res = await get(`/packages/${MISSING_UUID}/header-footer/resolved`);
    expect(res.status).toBe(404);
  });

  it('404 for a nonexistent revision id', async () => {
    const res = await get(`/revisions/${MISSING_UUID}/header-footer/resolved`);
    expect(res.status).toBe(404);
  });

  it('400 on a malformed anchor id', async () => {
    const res = await get(`/projects/not-a-uuid/header-footer/resolved`);
    expect(res.status).toBe(400);
  });
});

// ─── Invariant: the response is ResolvedHeaderFooterConfig verbatim ────────

describe('GET .../header-footer/resolved — single layer (no overrides)', () => {
  it('returns context + layers + config verbatim, no invented winningScope field', async () => {
    const projectId = await insertProject();
    await upsertHeaderFooterConfig(
      { projectId },
      {
        header: { center: { content: [{ kind: 'projectName' }] } },
      }
    );

    const res = await get(`/projects/${projectId}/header-footer/resolved`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResolveEnvelope;

    // Exactly the ResolvedHeaderFooterConfig shape — no reshaping, no extra keys.
    expect(Object.keys(json.data).sort((a, b) => a.localeCompare(b))).toEqual([
      'config',
      'context',
      'layers',
    ]);

    expect(json.data.context.projectId).toBe(projectId);
    expect(json.data.context.clientLibraryId).toBeNull();
    expect(json.data.layers).toHaveLength(1);
    expect(json.data.layers[0]?.scope).toEqual({ kind: 'project', projectId });
    expect(json.data.config).toEqual({
      header: { center: { content: [{ kind: 'projectName' }] } },
    });
  });
});

describe('GET .../header-footer/resolved — layered scope chain', () => {
  it('layers[layers.length-1].scope is always the winning-scope read, merged config reflects overrides', async () => {
    const projectId = await insertProject();
    const packageId = await insertPackage(projectId);
    const revisionId = await insertRevision(packageId);

    const clientLibrary = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}client-${uniqueSuffix()}`,
    });
    await attachClientSource(projectId, clientLibrary.id);

    await upsertHeaderFooterConfig(
      { clientLibraryId: clientLibrary.id },
      { header: { center: { content: [{ kind: 'clientName' }] } } }
    );
    await upsertHeaderFooterConfig(
      { projectId },
      { header: { left: { content: [{ kind: 'projectName' }] } } }
    );
    await upsertHeaderFooterConfig(
      { packageId },
      { footer: { right: { content: [{ kind: 'packageName' }] } } }
    );
    await upsertHeaderFooterConfig(
      { revisionId },
      { footer: { right: { content: [{ kind: 'revisionLabel' }] } } }
    );

    const res = await get(`/revisions/${revisionId}/header-footer/resolved`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResolveEnvelope;

    expect(json.data.layers).toHaveLength(4);
    const winningLayer = json.data.layers[json.data.layers.length - 1];
    expect(winningLayer?.scope).toEqual({ kind: 'revision', revisionId });

    // Client + project contributions survive (not overridden); package's
    // footer.right is overridden by revision's later layer.
    expect(json.data.config).toEqual({
      header: {
        center: { content: [{ kind: 'clientName' }] },
        left: { content: [{ kind: 'projectName' }] },
      },
      footer: { right: { content: [{ kind: 'revisionLabel' }] } },
    });
  });
});

describe('GET .../header-footer/resolved — single revision layer via chain with no overrides above', () => {
  it('resolves a bare revision with only itself configured', async () => {
    const projectId = await insertProject();
    const packageId = await insertPackage(projectId);
    const revisionId = await insertRevision(packageId);
    await upsertHeaderFooterConfig(
      { revisionId },
      { footer: { center: { content: [{ kind: 'pageNumber' }] } } }
    );

    const res = await get(`/packages/${packageId}/header-footer/resolved`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as ResolveEnvelope;
    // Resolving at the package anchor never sees the revision-scoped config —
    // only client/project/package layers are in scope for a package context.
    expect(json.data.layers).toHaveLength(0);
    expect(json.data.config).toEqual({});
  });
});
