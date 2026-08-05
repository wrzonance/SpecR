import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { pool, createLibrary, upsertHeaderFooterConfig } from '../db/index.js';
import type { ResolvedHeaderFooterConfig } from '../db/index.js';
import {
  handleResolveProjectHeaderFooter,
  handleResolvePackageHeaderFooter,
  handleResolveRevisionHeaderFooter,
} from './header-footer-resolve-handlers.js';
import type { ToolResult } from './handlers.js';

// ─── Test setup ────────────────────────────────────────────────────────────

const TEST_PREFIX = 'hf-mcp-resolve-';
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

let fixtureCounter = 0;
function uniqueSuffix(): string {
  fixtureCounter += 1;
  return `${Date.now()}-${fixtureCounter}`;
}

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}

function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function makeProjectId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`${TEST_PREFIX}project-${uniqueSuffix()}`, 'header/footer resolve MCP test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('makeProjectId: no project id returned');
  return row.id;
}

async function makePackageId(projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${TEST_PREFIX}package-${uniqueSuffix()}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('makePackageId: no package id returned');
  return row.id;
}

async function makeRevisionId(packageId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO package_revisions
       (package_id, label, revision_type, revision_date, sort_order, attributes)
     VALUES ($1, 'Addendum 1', 'addendum', '2026-06-18'::date, 1, '{"number":1}'::jsonb)
     RETURNING id`,
    [packageId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('makeRevisionId: no revision id returned');
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

afterAll(async () => {
  await pool.end();
});

// ─── Invariant: MCP tool handlers never throw ───────────────────────────────

describe('resolve header/footer MCP tools never throw', () => {
  it('resolve on a nonexistent project id is a tool error, not a thrown exception', async () => {
    await expect(
      handleResolveProjectHeaderFooter({ projectId: MISSING_UUID })
    ).resolves.not.toThrow();
    const res = await handleResolveProjectHeaderFooter({ projectId: MISSING_UUID });
    expect(isToolError(res)).toBe(true);
  });

  it('resolve on a nonexistent package id is a tool error, not a thrown exception', async () => {
    const res = await handleResolvePackageHeaderFooter({ packageId: MISSING_UUID });
    expect(isToolError(res)).toBe(true);
  });

  it('resolve on a nonexistent revision id is a tool error, not a thrown exception', async () => {
    const res = await handleResolveRevisionHeaderFooter({ revisionId: MISSING_UUID });
    expect(isToolError(res)).toBe(true);
  });

  it('malformed arg shape (missing id) is a tool error, not a thrown exception', async () => {
    const res = await handleResolveProjectHeaderFooter({});
    expect(isToolError(res)).toBe(true);
  });
});

// ─── Invariant: the response is ResolvedHeaderFooterConfig verbatim ────────

describe('resolve_project_header_footer — single layer (no overrides)', () => {
  it('returns context + layers + config verbatim, no invented winningScope field', async () => {
    const projectId = await makeProjectId();
    await upsertHeaderFooterConfig(
      { projectId },
      { header: { center: { content: [{ kind: 'projectName' }] } } }
    );

    const res = await handleResolveProjectHeaderFooter({ projectId });
    expect(isToolError(res)).toBe(false);
    const body = parse<ResolvedHeaderFooterConfig>(res);

    expect(Object.keys(body).sort((a, b) => a.localeCompare(b))).toEqual([
      'config',
      'context',
      'layers',
    ]);
    expect(body.context.projectId).toBe(projectId);
    expect(body.context.clientLibraryId).toBeNull();
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0]?.scope).toEqual({ kind: 'project', projectId });
    expect(body.config).toEqual({
      header: { center: { content: [{ kind: 'projectName' }] } },
    });
  });
});

describe('resolve_revision_header_footer — layered scope chain', () => {
  it('layers[layers.length-1].scope is always the winning-scope read, merged config reflects overrides', async () => {
    const projectId = await makeProjectId();
    const packageId = await makePackageId(projectId);
    const revisionId = await makeRevisionId(packageId);

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

    const res = await handleResolveRevisionHeaderFooter({ revisionId });
    expect(isToolError(res)).toBe(false);
    const body = parse<ResolvedHeaderFooterConfig>(res);

    expect(body.layers).toHaveLength(4);
    const winningLayer = body.layers[body.layers.length - 1];
    expect(winningLayer?.scope).toEqual({ kind: 'revision', revisionId });
    expect(body.config).toEqual({
      header: {
        center: { content: [{ kind: 'clientName' }] },
        left: { content: [{ kind: 'projectName' }] },
      },
      footer: { right: { content: [{ kind: 'revisionLabel' }] } },
    });
  });
});

describe('resolve_package_header_footer — no config below the anchor', () => {
  it('resolving at the package anchor never sees revision-scoped config', async () => {
    const projectId = await makeProjectId();
    const packageId = await makePackageId(projectId);
    const revisionId = await makeRevisionId(packageId);
    await upsertHeaderFooterConfig(
      { revisionId },
      { footer: { center: { content: [{ kind: 'pageNumber' }] } } }
    );

    const res = await handleResolvePackageHeaderFooter({ packageId });
    expect(isToolError(res)).toBe(false);
    const body = parse<ResolvedHeaderFooterConfig>(res);
    expect(body.layers).toHaveLength(0);
    expect(body.config).toEqual({});
  });
});
