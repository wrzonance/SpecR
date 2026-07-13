import { afterAll, describe, expect, it } from 'vitest';
import { pool, createLibrary } from '../db/index.js';
import {
  handleGetLibraryHeaderFooter,
  handleSetLibraryHeaderFooter,
  handleClearLibraryHeaderFooter,
  handleGetProjectHeaderFooter,
  handleSetProjectHeaderFooter,
  handleClearProjectHeaderFooter,
  handleGetPackageHeaderFooter,
  handleSetPackageHeaderFooter,
  handleClearPackageHeaderFooter,
  handleGetRevisionHeaderFooter,
  handleSetRevisionHeaderFooter,
  handleClearRevisionHeaderFooter,
} from './header-footer-handlers.js';
import type { ToolResult } from './handlers.js';

// ─── Test setup ────────────────────────────────────────────────────────────

const TEST_PREFIX = 'hf-mcp-';
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

async function makeClientLibraryId(): Promise<string> {
  const lib = await createLibrary({
    tier: 'client',
    name: `${TEST_PREFIX}client-${uniqueSuffix()}`,
  });
  return lib.id;
}

async function makeCompanyLibraryId(): Promise<string> {
  const lib = await createLibrary({
    tier: 'company',
    name: `${TEST_PREFIX}company-${uniqueSuffix()}`,
  });
  return lib.id;
}

async function makeProjectId(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`${TEST_PREFIX}project-${uniqueSuffix()}`, 'header/footer MCP test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('makeProjectId: no project id returned');
  return row.id;
}

async function makePackageId(): Promise<string> {
  const projectId = await makeProjectId();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${TEST_PREFIX}package-${uniqueSuffix()}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('makePackageId: no package id returned');
  return row.id;
}

async function makeRevisionId(): Promise<string> {
  const packageId = await makePackageId();
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

afterAll(async () => {
  await pool.query(`DELETE FROM header_footer_configs`);
  await pool.query(
    `DELETE FROM package_revisions
     WHERE package_id IN (SELECT id FROM design_packages WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM design_packages WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.end();
});

const SAMPLE_CONFIG = {
  header: { center: { content: [{ kind: 'projectName' }] } },
  footer: { right: { content: [{ kind: 'pageNumber' }] } },
};

interface ScopeCase {
  readonly name: string;
  readonly makeId: () => Promise<string>;
  readonly get: (args: unknown) => Promise<ToolResult>;
  readonly set: (args: unknown) => Promise<ToolResult>;
  readonly clear: (args: unknown) => Promise<ToolResult>;
  readonly argKey: 'libraryId' | 'projectId' | 'packageId' | 'revisionId';
}

const SCOPE_CASES: readonly ScopeCase[] = [
  {
    name: 'library',
    makeId: makeClientLibraryId,
    get: handleGetLibraryHeaderFooter,
    set: handleSetLibraryHeaderFooter,
    clear: handleClearLibraryHeaderFooter,
    argKey: 'libraryId',
  },
  {
    name: 'project',
    makeId: makeProjectId,
    get: handleGetProjectHeaderFooter,
    set: handleSetProjectHeaderFooter,
    clear: handleClearProjectHeaderFooter,
    argKey: 'projectId',
  },
  {
    name: 'package',
    makeId: makePackageId,
    get: handleGetPackageHeaderFooter,
    set: handleSetPackageHeaderFooter,
    clear: handleClearPackageHeaderFooter,
    argKey: 'packageId',
  },
  {
    name: 'revision',
    makeId: makeRevisionId,
    get: handleGetRevisionHeaderFooter,
    set: handleSetRevisionHeaderFooter,
    clear: handleClearRevisionHeaderFooter,
    argKey: 'revisionId',
  },
];

// ─── Invariant: MCP tool handlers never throw ───────────────────────────────

describe.each(SCOPE_CASES)('$name header/footer MCP tools never throw', (scopeCase) => {
  it('get on a missing anchor is a tool error, not a thrown exception', async () => {
    await expect(scopeCase.get({ [scopeCase.argKey]: MISSING_UUID })).resolves.not.toThrow();
    const res = await scopeCase.get({ [scopeCase.argKey]: MISSING_UUID });
    expect(isToolError(res)).toBe(true);
  });

  it('set with a malformed body is a tool error, not a thrown exception', async () => {
    const id = await scopeCase.makeId();
    const res = await scopeCase.set({
      [scopeCase.argKey]: id,
      config: { header: { center: 'not-an-object' } },
    });
    expect(isToolError(res)).toBe(true);
  });

  it('malformed arg shape (missing id) is a tool error, not a thrown exception', async () => {
    const res = await scopeCase.get({});
    expect(isToolError(res)).toBe(true);
  });
});

// ─── Invariant: GET/CLEAR error on a missing scope row ──────────────────────

describe.each(SCOPE_CASES)('$name header/footer — no config row', (scopeCase) => {
  it('get is a tool error when no config exists for an existing anchor', async () => {
    const id = await scopeCase.makeId();
    const res = await scopeCase.get({ [scopeCase.argKey]: id });
    expect(isToolError(res)).toBe(true);
  });

  it('clear is a tool error when no config exists for an existing anchor', async () => {
    const id = await scopeCase.makeId();
    const res = await scopeCase.clear({ [scopeCase.argKey]: id });
    expect(isToolError(res)).toBe(true);
  });
});

// ─── Invariant: catchall round-trip fidelity (spike finding #1 regression) ──

describe.each(SCOPE_CASES)('$name header/footer catchall fidelity', (scopeCase) => {
  it('set then get round-trips an unrecognized top-level extension key', async () => {
    const id = await scopeCase.makeId();
    const configWithExtension = { ...SAMPLE_CONFIG, xClientExtension: { note: 'keep me' } };

    const setRes = await scopeCase.set({ [scopeCase.argKey]: id, config: configWithExtension });
    expect(isToolError(setRes)).toBe(false);
    const setBody = parse<{ config: Record<string, unknown> }>(setRes);
    expect(setBody.config['xClientExtension']).toEqual({ note: 'keep me' });

    const getRes = await scopeCase.get({ [scopeCase.argKey]: id });
    expect(isToolError(getRes)).toBe(false);
    const getBody = parse<{ config: Record<string, unknown> }>(getRes);
    expect(getBody.config['xClientExtension']).toEqual({ note: 'keep me' });
  });
});

// ─── Client-scope specific: existence guard (spike finding #2) ─────────────

describe('client-scope header/footer guard', () => {
  it('set is a tool error (not found) against a nonexistent library id', async () => {
    const res = await handleSetLibraryHeaderFooter({
      libraryId: MISSING_UUID,
      config: SAMPLE_CONFIG,
    });
    expect(isToolError(res)).toBe(true);
    const text = (res as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/not found/);
  });

  it('clear is a tool error (not found) against a nonexistent library id', async () => {
    const res = await handleClearLibraryHeaderFooter({ libraryId: MISSING_UUID });
    expect(isToolError(res)).toBe(true);
    const text = (res as { content: { text: string }[] }).content[0]!.text;
    expect(text).toMatch(/not found/);
  });

  it('set is a tool error against a library that exists but is not tier=client', async () => {
    const companyLibId = await makeCompanyLibraryId();
    const res = await handleSetLibraryHeaderFooter({
      libraryId: companyLibId,
      config: SAMPLE_CONFIG,
    });
    expect(isToolError(res)).toBe(true);
  });
});

// ─── Invariant: set is an upsert (replace-in-place) ─────────────────────────

describe.each(SCOPE_CASES)('$name header/footer upsert', (scopeCase) => {
  it('set twice replaces the config in place', async () => {
    const id = await scopeCase.makeId();
    const created = await scopeCase.set({ [scopeCase.argKey]: id, config: SAMPLE_CONFIG });
    expect(isToolError(created)).toBe(false);

    const replacement = { ...SAMPLE_CONFIG, pageNumbering: { mode: 'continuous' } };
    const replaced = await scopeCase.set({ [scopeCase.argKey]: id, config: replacement });
    expect(isToolError(replaced)).toBe(false);

    const fetched = parse<{ config: unknown }>(await scopeCase.get({ [scopeCase.argKey]: id }));
    expect(fetched.config).toEqual(replacement);
  });
});
