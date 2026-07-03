import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/index.js';
import {
  handleAddProjectSection,
  handleRemoveProjectSection,
  handleSetProjectSources,
} from './project-membership-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';
const suffix = randomUUID().slice(0, 8);
const createdProjects: string[] = [];
const createdLibraries: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

async function insertLibrary(tier: string, tag: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, `w2a ${tag} ${suffix} ${randomUUID().slice(0, 6)}`]
  );
  const id = r.rows[0]!.id;
  createdLibraries.push(id);
  return id;
}
async function insertMaster(libraryId: string, section: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `w2a ${section}`, libraryId]
  );
  const specId = r.rows[0]!.id;
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, NULL, 'part', 'GENERAL', 0)`,
    [specId]
  );
  return specId;
}
async function insertProject(sourceLibraryIds: readonly string[]): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`w2a project ${randomUUID().slice(0, 8)}`]
  );
  const projectId = r.rows[0]!.id;
  createdProjects.push(projectId);
  for (const [i, libId] of sourceLibraryIds.entries()) {
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, $3)`,
      [projectId, libId, i + 1]
    );
  }
  return projectId;
}

afterAll(async () => {
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM spec_references WHERE source_spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))',
    [createdProjects]
  );
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))',
    [createdProjects]
  );
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE library_id = ANY($1))',
    [createdLibraries]
  );
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [createdLibraries]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [createdLibraries]);
});

interface AddResult {
  specId: string;
  section: string;
}

describe('project section membership + sources MCP tools', () => {
  it('adds a section to a project (copy-on-derive), then rejects a duplicate add', async () => {
    const lib = await insertLibrary('company', 'add');
    await insertMaster(lib, '03 30 00');
    const projectId = await insertProject([lib]);

    const res = await handleAddProjectSection({ projectId, section: '03 30 00' });
    expect(isToolError(res)).toBe(false);
    expect(parse<AddResult>(res).section).toBe('03 30 00');

    // duplicate → 23505 → tool error
    expect(isToolError(await handleAddProjectSection({ projectId, section: '03 30 00' }))).toBe(
      true
    );
  });

  it('add_project_section rejects an unknown project, an unresolved section, and bad input', async () => {
    const lib = await insertLibrary('company', 'add-bad');
    await insertMaster(lib, '03 30 00');
    const projectId = await insertProject([lib]);
    expect(
      isToolError(await handleAddProjectSection({ projectId: MISSING, section: '03 30 00' }))
    ).toBe(true);
    // no source library holds 99 99 99 → unresolved
    expect(isToolError(await handleAddProjectSection({ projectId, section: '99 99 99' }))).toBe(
      true
    );
    // missing section field → schema error
    expect(isToolError(await handleAddProjectSection({ projectId }))).toBe(true);
  });

  it('removes a cloned section; force is required once it has edits', async () => {
    const lib = await insertLibrary('company', 'remove');
    await insertMaster(lib, '07 21 16');
    const projectId = await insertProject([lib]);
    const added = parse<AddResult>(
      await handleAddProjectSection({ projectId, section: '07 21 16' })
    );

    // simulate a project edit → removal now needs force
    await pool.query(`UPDATE specs SET content_version = 2 WHERE id = $1`, [added.specId]);
    const blocked = await handleRemoveProjectSection({ projectId, specId: added.specId });
    expect(isToolError(blocked)).toBe(true);

    const forced = await handleRemoveProjectSection({
      projectId,
      specId: added.specId,
      force: true,
    });
    expect(isToolError(forced)).toBe(false);
    expect(parse<{ removed: boolean }>(forced).removed).toBe(true);
  });

  it('remove_project_section reports not-found for an unknown spec', async () => {
    const projectId = await insertProject([]);
    expect(isToolError(await handleRemoveProjectSection({ projectId, specId: MISSING }))).toBe(
      true
    );
  });

  it('sets a project’s source libraries', async () => {
    const lib = await insertLibrary('company', 'sources');
    const projectId = await insertProject([]);
    const res = await handleSetProjectSources({ projectId, sourceLibraryIds: [lib] });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ sources: unknown[] }>(res).sources.length).toBe(1);
  });

  it('set_project_sources rejects unknown project, unknown/invalid library, and bad input', async () => {
    const lib = await insertLibrary('company', 'sources-bad');
    // unknown project
    expect(
      isToolError(await handleSetProjectSources({ projectId: MISSING, sourceLibraryIds: [lib] }))
    ).toBe(true);
    const projectId = await insertProject([]);
    // unknown library id → InvalidSourceLibraryError
    expect(
      isToolError(await handleSetProjectSources({ projectId, sourceLibraryIds: [MISSING] }))
    ).toBe(true);
    // empty array → schema error
    expect(isToolError(await handleSetProjectSources({ projectId, sourceLibraryIds: [] }))).toBe(
      true
    );
    // duplicates → schema error
    expect(
      isToolError(await handleSetProjectSources({ projectId, sourceLibraryIds: [lib, lib] }))
    ).toBe(true);
  });
});
