import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../parser/index.js';
import { pool, addSectionToProject, persistParsedSpec } from '../db/index.js';
import { buildComparisonReport } from './index.js';

// Copyrighted reference DOCX are gitignored — present only in local dev, absent in
// CI. This layer proves origin-alignment ignores the CPI reserved-ilvl offset
// (CLAUDE.md gotcha): a faithful clone aligns to its master by resolved origin
// regardless of each document's ilvl/position, for both the cleanest (ARCAT) and
// the offset (CPI) corpora.
const ARCAT = resolve('docs/references/ARCAT/07_21_00ksp.docx');
const CPI = resolve('docs/references/MANUFACTURER_CPI/CPI_BUSBAR_CSIMFS.docx');
const FIXTURES_AVAILABLE = existsSync(ARCAT) && existsSync(CPI);

const createdLibs: string[] = [];
const createdProjects: string[] = [];

async function createLibrary(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [name]
  );
  const id = r.rows[0]?.id ?? '';
  createdLibs.push(id);
  return id;
}

async function createProject(name: string, libraryId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const id = r.rows[0]?.id ?? '';
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [id, libraryId]
  );
  createdProjects.push(id);
  return id;
}

async function persistMaster(
  path: string,
  libraryId: string
): Promise<{ specId: string; section: string }> {
  const buffer = readFileSync(path);
  const result = await parse(buffer, path);
  const specId = await persistParsedSpec({ tree: result.tree, refs: result.refs, libraryId });
  return { specId, section: result.tree.section };
}

async function driveComparison(fixturePath: string, tag: string): Promise<void> {
  const lib = await createLibrary(`Compare Fixture ${tag} ${Date.now()}`);
  const master = await persistMaster(fixturePath, lib);
  const project = await createProject(`Compare Fixture Project ${tag} ${Date.now()}`, lib);
  const clone = await addSectionToProject(project, master.section, pool);
  const report = await buildComparisonReport([clone.specId, master.specId]);
  // A faithful clone aligns to its master on every paragraph by resolved origin —
  // the ilvl/position offset never enters the key.
  expect(report.rows.length).toBeGreaterThan(0);
  const bothPresent = report.rows.every((r) => r.cells[0]?.present && r.cells[1]?.present);
  expect(bothPresent).toBe(true);
}

afterAll(async () => {
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM spec_references WHERE source_spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1) OR library_id = ANY($2))',
    [createdProjects, createdLibs]
  );
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1) OR library_id = ANY($2))',
    [createdProjects, createdLibs]
  );
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [createdLibs]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [createdLibs]);
});

describe.skipIf(!FIXTURES_AVAILABLE)('cross-spec comparison against real corpora', () => {
  it('aligns an ARCAT clone to its master by origin (cleanest corpus)', async () => {
    await driveComparison(ARCAT, 'ARCAT');
  });

  it('aligns a CPI clone to its master by origin despite the reserved-ilvl offset', async () => {
    await driveComparison(CPI, 'CPI');
  });
});
