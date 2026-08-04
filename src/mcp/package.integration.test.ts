import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool, addSectionToProject } from '../db/index.js';
import {
  handleListPackages,
  handleCreatePackage,
  handleSetPackageSpecs,
  handleDeletePackage,
} from './package-handlers.js';
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

async function insertLibrary(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [`w2b ${suffix} ${randomUUID().slice(0, 6)}`]
  );
  const id = r.rows[0]!.id;
  createdLibraries.push(id);
  return id;
}
async function insertMaster(libraryId: string, section: string): Promise<void> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, `w2b ${section}`, libraryId]
  );
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position) VALUES ($1, NULL, 'part', 'GENERAL', 0)`,
    [r.rows[0]!.id]
  );
}
async function insertProject(libraryId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`w2b project ${randomUUID().slice(0, 8)}`]
  );
  const projectId = r.rows[0]!.id;
  createdProjects.push(projectId);
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, libraryId]
  );
  return projectId;
}
// A project with one section in its TOC — returns { projectId, specId }.
async function projectWithSection(section: string): Promise<{ projectId: string; specId: string }> {
  const lib = await insertLibrary();
  await insertMaster(lib, section);
  const projectId = await insertProject(lib);
  const added = await addSectionToProject(projectId, section, pool);
  return { projectId, specId: added.specId };
}

afterAll(async () => {
  // design_packages first (package_specs.spec_id is RESTRICT); then project_specs → refs → paragraphs → specs.
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [createdProjects]);
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

interface PackageSummary {
  packageId: string;
  name: string;
}

describe('design package MCP tools', () => {
  it('creates a package, lists it, then deletes it', async () => {
    const { projectId } = await projectWithSection('03 30 00');
    const created = parse<PackageSummary>(
      await handleCreatePackage({ projectId, name: 'Bid Set' })
    );
    expect(created.name).toBe('Bid Set');

    const packages = parse<PackageSummary[]>(await handleListPackages({ projectId }));
    expect(packages.map((p) => p.packageId)).toContain(created.packageId);

    const del = await handleDeletePackage({ packageId: created.packageId });
    expect(isToolError(del)).toBe(false);
    // #640: handleDeletePackage's success payload is exactly { packageId }, matching the
    // documented `delete /packages/{id}` 200 response — no extra `deleted` key.
    expect(parse<{ packageId: string }>(del)).toEqual({ packageId: created.packageId });
  });

  it('create_package rejects an unknown project, a duplicate name, and bad input', async () => {
    expect(isToolError(await handleCreatePackage({ projectId: MISSING, name: 'X' }))).toBe(true);
    const { projectId } = await projectWithSection('07 21 16');
    await handleCreatePackage({ projectId, name: 'Dup' });
    expect(isToolError(await handleCreatePackage({ projectId, name: 'Dup' }))).toBe(true);
    expect(isToolError(await handleCreatePackage({ projectId }))).toBe(true);
  });

  it('sets package members from the project TOC and rejects out-of-project specs', async () => {
    const { projectId, specId } = await projectWithSection('09 91 00');
    const pkg = parse<PackageSummary>(await handleCreatePackage({ projectId, name: 'Members' }));

    const res = await handleSetPackageSpecs({ packageId: pkg.packageId, specIds: [specId] });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ specs: unknown[] }>(res).specs.length).toBe(1);

    // a spec not in this project's TOC → not in project
    expect(
      isToolError(await handleSetPackageSpecs({ packageId: pkg.packageId, specIds: [MISSING] }))
    ).toBe(true);
    // unknown package
    expect(
      isToolError(await handleSetPackageSpecs({ packageId: MISSING, specIds: [specId] }))
    ).toBe(true);
    // bad input (specIds not an array of UUIDs)
    expect(
      isToolError(await handleSetPackageSpecs({ packageId: pkg.packageId, specIds: ['nope'] }))
    ).toBe(true);
  });

  it('list/delete_package reject bad input and unknown ids', async () => {
    expect(isToolError(await handleListPackages({ projectId: 'nope' }))).toBe(true);
    expect(isToolError(await handleListPackages({ projectId: MISSING }))).toBe(true);
    expect(isToolError(await handleDeletePackage({ packageId: 'nope' }))).toBe(true);
    expect(isToolError(await handleDeletePackage({ packageId: MISSING }))).toBe(true);
  });
});
