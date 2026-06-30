import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../index.js';
import { getProjectKeynotes } from './keynotes.js';

// ── Raw-insert helpers (tests must not depend on the code under test) ─────────

const libIds: string[] = [];
const projectIds: string[] = [];

async function insertLibrary(tier: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  if (!r.rows[0]) throw new Error('insertLibrary failed');
  libIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function insertProjectWithSources(
  name: string,
  libraryIds: readonly string[]
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  if (!r.rows[0]) throw new Error('insertProject failed');
  const projectId = r.rows[0].id;
  projectIds.push(projectId);
  for (const [i, libId] of libraryIds.entries()) {
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, $3)`,
      [projectId, libId, i + 1]
    );
  }
  return projectId;
}

// Adds a section to the project TOC as a project-copy spec (project_id owner).
async function addTocSection(
  projectId: string,
  section: string,
  position: number
): Promise<string> {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id)
     VALUES ($1, $2, 'arcat', $3) RETURNING id`,
    [section, `Title ${section}`, projectId]
  );
  if (!spec.rows[0]) throw new Error('addTocSection: spec insert failed');
  const specId = spec.rows[0].id;
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [projectId, specId, position]
  );
  return specId;
}

async function insertParagraph(specId: string, text: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'paragraph', $2, 1)
     RETURNING id`,
    [specId, text]
  );
  if (!r.rows[0]) throw new Error('insertParagraph failed');
  return r.rows[0].id;
}

interface KeynoteSeed {
  readonly libraryId: string;
  readonly code: string;
  readonly description: string;
  readonly targetSection: string;
  readonly parentCode?: string;
  readonly targetParagraphId?: string;
}

async function insertKeynote(seed: KeynoteSeed): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO keynotes (library_id, code, parent_code, description, target_section, target_paragraph_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      seed.libraryId,
      seed.code,
      seed.parentCode ?? null,
      seed.description,
      seed.targetSection,
      seed.targetParagraphId ?? null,
    ]
  );
  if (!r.rows[0]) throw new Error('insertKeynote failed');
  return r.rows[0].id;
}

// ── Fixture ──────────────────────────────────────────────────────────────────
// Sections '88 77 0x' are in the project TOC; '88 99 00' is intentionally absent.

const suffix = randomUUID().slice(0, 8);
let companyLib: string; // project source, priority 1
let clientLib: string; // project source, priority 2
let strayLib: string; // NOT a project source
let projectId: string;
let deepLinkParagraphId: string;

beforeAll(async () => {
  companyLib = await insertLibrary('company', `Keynote Co ${suffix}`);
  clientLib = await insertLibrary('client', `Keynote Client ${suffix}`);
  strayLib = await insertLibrary('company', `Keynote Stray ${suffix}`);

  projectId = await insertProjectWithSources(`keynote-proj-${suffix}`, [companyLib, clientLib]);
  const ceilingSpec = await addTocSection(projectId, '88 77 01', 1); // in TOC
  await addTocSection(projectId, '88 77 02', 2); // in TOC
  deepLinkParagraphId = await insertParagraph(ceilingSpec, 'Acoustical ceiling panels.');

  // In TOC + source library → INCLUDED.
  await insertKeynote({
    libraryId: companyLib,
    code: 'A-CEIL',
    description: 'Acoustical ceiling',
    targetSection: '88 77 01',
    parentCode: 'A',
    targetParagraphId: deepLinkParagraphId,
  });
  await insertKeynote({
    libraryId: clientLib,
    code: 'B-CLIENT',
    description: 'Client special',
    targetSection: '88 77 02',
  });

  // Source library but target section NOT in TOC → EXCLUDED.
  await insertKeynote({
    libraryId: companyLib,
    code: 'C-PAINT',
    description: 'Paint not in manual',
    targetSection: '88 99 00',
  });

  // In TOC but library is NOT a project source → EXCLUDED.
  await insertKeynote({
    libraryId: strayLib,
    code: 'D-STRAY',
    description: 'From a non-source library',
    targetSection: '88 77 01',
  });

  // Same code in both source libraries, both in TOC → resolves to priority 1.
  await insertKeynote({
    libraryId: companyLib,
    code: 'E-DUP',
    description: 'Company wins',
    targetSection: '88 77 01',
  });
  await insertKeynote({
    libraryId: clientLib,
    code: 'E-DUP',
    description: 'Client loses',
    targetSection: '88 77 02',
  });
});

afterAll(async () => {
  await pool.query(`DELETE FROM keynotes WHERE library_id = ANY($1::uuid[])`, [libIds]);
  await pool.query(`DELETE FROM project_specs WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM project_sources WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(
    `DELETE FROM specs WHERE library_id = ANY($1::uuid[]) OR project_id = ANY($2::uuid[])`,
    [libIds, projectIds]
  );
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [libIds]);
});

describe('getProjectKeynotes — ADR-016 D2 filter', () => {
  it('keynote targeting a section not in the project TOC is excluded', async () => {
    const result = await getProjectKeynotes(projectId);
    const codes = result.map((k) => k.code);
    expect(codes).not.toContain('C-PAINT'); // target '88 99 00' is not in the TOC
  });

  it('keynote from a non-source library is excluded even when its section is in TOC', async () => {
    const result = await getProjectKeynotes(projectId);
    expect(result.map((k) => k.code)).not.toContain('D-STRAY');
  });

  it('includes valid keynotes from every source library, ordered by code', async () => {
    const result = await getProjectKeynotes(projectId);
    const codes = result.map((k) => k.code);
    expect(codes).toEqual(['A-CEIL', 'B-CLIENT', 'E-DUP']);
  });

  it('carries parent_code and the optional target_paragraph_id deep link through', async () => {
    const result = await getProjectKeynotes(projectId);
    const ceiling = result.find((k) => k.code === 'A-CEIL');
    expect(ceiling).toMatchObject({
      libraryId: companyLib,
      parentCode: 'A',
      description: 'Acoustical ceiling',
      targetSection: '88 77 01',
      targetParagraphId: deepLinkParagraphId,
    });
  });

  it('resolves a code carried by two source libraries to the higher-priority one', async () => {
    const result = await getProjectKeynotes(projectId);
    const dup = result.filter((k) => k.code === 'E-DUP');
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ libraryId: companyLib, description: 'Company wins' });
  });

  it('an unknown project has no sources or TOC, so it returns []', async () => {
    const result = await getProjectKeynotes(randomUUID());
    expect(result).toEqual([]);
  });
});

describe('keynotes table constraints — ADR-016 D1', () => {
  it('db: UNIQUE (library_id, code) rejects a duplicate code in the same library', async () => {
    await expect(
      insertKeynote({
        libraryId: companyLib,
        code: 'A-CEIL',
        description: 'dup',
        targetSection: '88 77 01',
      })
    ).rejects.toThrow(/keynotes_library_code_unique/);
  });

  it('db: the same code coexists across two libraries', async () => {
    // E-DUP already exists in both companyLib and clientLib (fixture) — proving
    // the unique key is scoped per library, not global.
    const r = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM keynotes WHERE code = 'E-DUP' AND library_id = ANY($1::uuid[])`,
      [libIds]
    );
    expect(r.rows[0]).toMatchObject({ n: 2 });
  });

  it('db: a blank code is rejected', async () => {
    await expect(
      insertKeynote({
        libraryId: companyLib,
        code: '   ',
        description: 'blank code',
        targetSection: '88 77 01',
      })
    ).rejects.toThrow(/keynotes_code_check/);
  });

  it('db: a blank description is rejected', async () => {
    await expect(
      insertKeynote({
        libraryId: companyLib,
        code: 'F-BLANK-DESC',
        description: '  ',
        targetSection: '88 77 01',
      })
    ).rejects.toThrow(/keynotes_description_check/);
  });
});
