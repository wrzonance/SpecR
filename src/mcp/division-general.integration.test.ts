import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import {
  handleGetLibraryGeneralSpec,
  handleGetProjectGeneralSpec,
  handleSetLibraryGeneralSpec,
  handleSetProjectGeneralSpec,
} from './division-general-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';
const suffix = randomUUID().slice(0, 8);
const libraries: string[] = [];
const projects: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function insertLibrary(tag: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [`dg-mcp ${tag} ${suffix}`]
  );
  const id = r.rows[0]!.id;
  libraries.push(id);
  return id;
}
async function insertProject(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`dg-mcp project ${randomUUID().slice(0, 8)}`]
  );
  const id = r.rows[0]!.id;
  projects.push(id);
  return id;
}
async function insertLibrarySpec(libraryId: string, section: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `dg-mcp ${section}`, libraryId]
  );
  return r.rows[0]!.id;
}
async function insertProjectSpec(projectId: string, section: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `dg-mcp ${section}`, projectId]
  );
  return r.rows[0]!.id;
}

afterAll(async () => {
  await pool.query('DELETE FROM division_general_specs WHERE library_id = ANY($1::uuid[])', [
    libraries,
  ]);
  await pool.query('DELETE FROM division_general_specs WHERE project_id = ANY($1::uuid[])', [
    projects,
  ]);
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1::uuid[])', [projects]);
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1::uuid[])', [libraries]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1::uuid[])', [libraries]);
});

interface GeneralSpecResult {
  status: string;
  scope: string;
  ownerId: string;
  candidates: unknown[];
}

describe('division general-spec MCP tools', () => {
  it('get_library_general_spec resolves an exact NN 00 00 section', async () => {
    const libraryId = await insertLibrary('get-resolved');
    await insertLibrarySpec(libraryId, '27 00 00');
    const res = await handleGetLibraryGeneralSpec({ libraryId, division: '27' });
    expect(isToolError(res)).toBe(false);
    expect(parse<GeneralSpecResult>(res).status).toBe('resolved');
  });

  it('get_library_general_spec reports missing with ranked candidates', async () => {
    const libraryId = await insertLibrary('get-missing');
    await insertLibrarySpec(libraryId, '27 10 00');
    const got = parse<GeneralSpecResult>(
      await handleGetLibraryGeneralSpec({ libraryId, division: '27' })
    );
    expect(got.status).toBe('missing');
    expect(got.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('get_library_general_spec rejects a bad division, a bad UUID, and an unknown owner', async () => {
    const libraryId = await insertLibrary('get-bad');
    expect(isToolError(await handleGetLibraryGeneralSpec({ libraryId, division: '7' }))).toBe(true);
    expect(
      isToolError(await handleGetLibraryGeneralSpec({ libraryId: 'nope', division: '27' }))
    ).toBe(true);
    expect(
      isToolError(await handleGetLibraryGeneralSpec({ libraryId: MISSING, division: '27' }))
    ).toBe(true);
  });

  it('get_project_general_spec resolves for a project and errors on an unknown owner', async () => {
    const projectId = await insertProject();
    await insertProjectSpec(projectId, '27 00 00');
    const got = parse<GeneralSpecResult>(
      await handleGetProjectGeneralSpec({ projectId, division: '27' })
    );
    expect(got.scope).toBe('project');
    expect(got.status).toBe('resolved');
    expect(
      isToolError(await handleGetProjectGeneralSpec({ projectId: MISSING, division: '27' }))
    ).toBe(true);
  });

  it('set_library_general_spec assigns a spec, then records not_applicable', async () => {
    const libraryId = await insertLibrary('set-ok');
    const specId = await insertLibrarySpec(libraryId, '27 10 00');
    const assigned = await handleSetLibraryGeneralSpec({
      libraryId,
      division: '27',
      generalSpecId: specId,
    });
    expect(isToolError(assigned)).toBe(false);
    expect(parse<GeneralSpecResult>(assigned).status).toBe('resolved');

    const na = await handleSetLibraryGeneralSpec({
      libraryId,
      division: '27',
      status: 'not_applicable',
    });
    expect(isToolError(na)).toBe(false);
    expect(parse<GeneralSpecResult>(na).status).toBe('not_applicable');
  });

  it('set_library_general_spec rejects a bad UUID, an XOR violation, a not-in-scope spec, and unknown owner', async () => {
    const libraryId = await insertLibrary('set-bad');
    // bad owner UUID
    expect(
      isToolError(
        await handleSetLibraryGeneralSpec({
          libraryId: 'nope',
          division: '27',
          status: 'not_applicable',
        })
      )
    ).toBe(true);
    // XOR: neither generalSpecId nor status
    expect(isToolError(await handleSetLibraryGeneralSpec({ libraryId, division: '27' }))).toBe(
      true
    );
    // spec in a different division → not in scope
    const wrongDivision = await insertLibrarySpec(libraryId, '28 00 00');
    expect(
      isToolError(
        await handleSetLibraryGeneralSpec({
          libraryId,
          division: '27',
          generalSpecId: wrongDivision,
        })
      )
    ).toBe(true);
    // unknown owner
    expect(
      isToolError(
        await handleSetLibraryGeneralSpec({
          libraryId: MISSING,
          division: '27',
          status: 'not_applicable',
        })
      )
    ).toBe(true);
  });

  it('set_project_general_spec assigns a spec and errors on an unknown owner', async () => {
    const projectId = await insertProject();
    const specId = await insertProjectSpec(projectId, '27 10 00');
    const res = await handleSetProjectGeneralSpec({
      projectId,
      division: '27',
      generalSpecId: specId,
    });
    expect(isToolError(res)).toBe(false);
    expect(parse<GeneralSpecResult>(res).status).toBe('resolved');
    expect(
      isToolError(
        await handleSetProjectGeneralSpec({
          projectId: MISSING,
          division: '27',
          status: 'not_applicable',
        })
      )
    ).toBe(true);
  });
});
