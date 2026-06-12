import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../index.js';
import {
  addSectionToProject,
  removeSectionFromProject,
  ProjectNotFoundError,
  SectionUnresolvedError,
} from './derive.js';
import { getPgCode } from '../../lib/pg-errors.js';

// ── SQL helpers (raw inserts — tests must not depend on the code under test) ──

async function insertLibrary(tier: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  if (!r.rows[0]) throw new Error('insertLibrary failed');
  return r.rows[0].id;
}

async function insertMaster(libraryId: string, section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ($1, $2, 'unknown', $3, 3, '{"filename":"x.docx","sha256":"abc","loader":"docx"}')
     RETURNING id`,
    [section, title, libraryId]
  );
  if (!r.rows[0]) throw new Error('insertMaster failed');
  return r.rows[0].id;
}

async function insertParagraph(
  specId: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number,
  extra?: { vanish?: boolean; conflicts?: string }
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish, conflicts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [specId, parentId, nodeType, text, position, extra?.vanish ?? false, extra?.conflicts ?? '[]']
  );
  if (!r.rows[0]) throw new Error('insertParagraph failed');
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
  for (const [i, libId] of libraryIds.entries()) {
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, $3)`,
      [projectId, libId, i + 1]
    );
  }
  return projectId;
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const suffix = randomUUID().slice(0, 8);
let companyLib: string;
let clientLib: string;
let masterId: string; // '03 30 00' in company lib — 4-paragraph tree incl. empty text
let masterParaIds: string[] = [];
const createdProjects: string[] = [];

beforeAll(async () => {
  companyLib = await insertLibrary('company', `Derive Co ${suffix}`);
  clientLib = await insertLibrary('client', `Derive Client ${suffix}`);
  masterId = await insertMaster(companyLib, '03 30 00', 'Concrete');
  // tree: part → article → pr1; plus an EMPTY-text pr1 (losslessness pin) and a
  // vanish+conflicts paragraph.
  const part = await insertParagraph(masterId, null, 'part', 'PART 1 GENERAL', 1);
  const article = await insertParagraph(masterId, part, 'article', 'SUMMARY', 1);
  const pr1 = await insertParagraph(masterId, article, 'pr1', 'Section includes concrete.', 1, {
    vanish: true,
    conflicts: '[{"signal":2,"reportedIlvl":1,"reportedNodeType":"pr2"}]',
  });
  const empty = await insertParagraph(masterId, article, 'pr1', '', 2);
  masterParaIds = [part, article, pr1, empty];
  // company lib also holds 09 91 00 (fallback + ref-repair target)
  await insertMaster(companyLib, '09 91 00', 'Painting');
  // both libs hold 04 20 00 (shadow advisory)
  await insertMaster(companyLib, '04 20 00', 'Unit Masonry');
  await insertMaster(clientLib, '04 20 00', 'Unit Masonry (Client)');
  // master ref: 03 30 00 → 09 91 00 (section), plus a standard ref
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
     VALUES ($1, $2, 'section', '09 91 00', 'See Section 09 91 00')`,
    [masterId, pr1]
  );
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, standard_code, reference_text)
     VALUES ($1, $2, 'standard', 'ASTM C150', 'ASTM C150')`,
    [masterId, pr1]
  );
});

afterAll(async () => {
  // FK ordering: design_packages (→ package_specs ON CASCADE) must go before specs
  // because package_specs.spec_id is ON DELETE RESTRICT.
  // Then: project_specs → spec_references → paragraphs → specs → projects → libraries.
  // project_specs.spec_id has no ON DELETE CASCADE on the specs side, so specs must be
  // deleted after project_specs. specs.project_id has no CASCADE either.
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
    'DELETE FROM spec_references WHERE source_spec_id IN (SELECT id FROM specs WHERE library_id = ANY($1))',
    [[companyLib, clientLib]]
  );
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE library_id = ANY($1))',
    [[companyLib, clientLib]]
  );
  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [[companyLib, clientLib]]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [[companyLib, clientLib]]);
});

async function newProject(libs: readonly string[]): Promise<string> {
  const id = await insertProjectWithSources(`derive-test-${randomUUID().slice(0, 8)}`, libs);
  createdProjects.push(id);
  return id;
}

describe('addSectionToProject — clone correctness', () => {
  let projectId: string;
  let cloneId: string;

  beforeAll(async () => {
    projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '03 30 00', pool);
    cloneId = result.specId;
    expect(result.section).toBe('03 30 00');
    expect(result.position).toBe(1);
    expect(result.source).toEqual({ libraryId: companyLib, name: `Derive Co ${suffix}` });
    expect(result.shadowed).toBeUndefined();
  });

  it('clone spec row carries lineage: parent, origin_version, content_version=1, origin_meta', async () => {
    const r = await pool.query<{
      project_id: string;
      library_id: string | null;
      parent_spec_id: string;
      origin_version: number;
      content_version: number;
      origin_meta: { filename: string } | null;
    }>(
      `SELECT project_id, library_id, parent_spec_id, origin_version, content_version, origin_meta
       FROM specs WHERE id = $1`,
      [cloneId]
    );
    const row = r.rows[0];
    expect(cloneId).not.toBe(masterId);
    expect(row?.project_id).toBe(projectId);
    expect(row?.library_id).toBeNull();
    expect(row?.parent_spec_id).toBe(masterId);
    expect(row?.origin_version).toBe(3);
    expect(row?.content_version).toBe(1);
    expect(row?.origin_meta?.filename).toBe('x.docx');
  });

  it('clone is lossless: every master paragraph matched 1:1 on content + structure via origin map', async () => {
    // join clone rows to master rows through origin_paragraph_id and compare
    // content columns + remapped parent structure entirely in SQL.
    const r = await pool.query<{ total: string; matched: string; parent_ok: string }>(
      `SELECT
         (SELECT COUNT(*) FROM paragraphs WHERE spec_id = $1) AS total,
         (SELECT COUNT(*) FROM paragraphs c
            JOIN paragraphs m ON m.id = c.origin_paragraph_id
           WHERE c.spec_id = $2 AND m.spec_id = $1
             AND c.node_type = m.node_type AND c.text = m.text
             AND c.position = m.position AND c.vanish = m.vanish
             AND c.base_version = m.base_version
             AND c.conflicts::text = m.conflicts::text) AS matched,
         (SELECT COUNT(*) FROM paragraphs c
            JOIN paragraphs m ON m.id = c.origin_paragraph_id
            LEFT JOIN paragraphs cp ON cp.id = c.parent_id
           WHERE c.spec_id = $2
             AND (cp.origin_paragraph_id IS NOT DISTINCT FROM m.parent_id)) AS parent_ok`,
      [masterId, cloneId]
    );
    const row = r.rows[0];
    expect(row?.total).toBe('4'); // includes the empty-text paragraph
    expect(row?.matched).toBe(row?.total);
    expect(row?.parent_ok).toBe(row?.total);
  });

  it('all clone paragraph UUIDs are new and the origin map is complete', async () => {
    const r = await pool.query<{ id: string; origin_paragraph_id: string | null }>(
      `SELECT id, origin_paragraph_id FROM paragraphs WHERE spec_id = $1`,
      [cloneId]
    );
    const origins = r.rows.map((p) => p.origin_paragraph_id);
    expect(new Set(origins).size).toBe(masterParaIds.length);
    for (const p of r.rows) {
      expect(masterParaIds).not.toContain(p.id);
      expect(masterParaIds).toContain(p.origin_paragraph_id);
    }
  });

  it('clone refs: source ids remapped; section target broken (09 91 00 not in project); standard ref intact', async () => {
    const r = await pool.query<{
      target_type: string;
      target_spec_section: string | null;
      target_spec_id: string | null;
      is_broken: boolean;
      source_paragraph_id: string;
    }>(
      `SELECT target_type, target_spec_section, target_spec_id, is_broken, source_paragraph_id
       FROM spec_references WHERE source_spec_id = $1 ORDER BY target_type`,
      [cloneId]
    );
    expect(r.rows).toHaveLength(2);
    const section = r.rows.find((x) => x.target_type === 'section');
    const standard = r.rows.find((x) => x.target_type === 'standard');
    expect(section?.is_broken).toBe(true);
    expect(section?.target_spec_id).toBeNull();
    expect(section?.target_spec_section).toBe('09 91 00');
    expect(standard?.is_broken).toBe(false);
    expect(masterParaIds).not.toContain(section?.source_paragraph_id);
  });

  it('HEADLINE: editing the project copy leaves the master untouched', async () => {
    const clonePara = await pool.query<{ id: string; origin_paragraph_id: string }>(
      `SELECT id, origin_paragraph_id FROM paragraphs
       WHERE spec_id = $1 AND node_type = 'pr1' AND text <> ''`,
      [cloneId]
    );
    const cp = clonePara.rows[0];
    expect(cp).toBeDefined();
    await pool.query(`UPDATE paragraphs SET text = 'EDITED IN PROJECT' WHERE id = $1`, [cp?.id]);
    const master = await pool.query<{ text: string }>(`SELECT text FROM paragraphs WHERE id = $1`, [
      cp?.origin_paragraph_id,
    ]);
    expect(master.rows[0]?.text).toBe('Section includes concrete.');
  });

  it('adding the target section repairs the broken clone ref to point at the NEW clone; master ref untouched', async () => {
    const added = await addSectionToProject(projectId, '09 91 00', pool);
    const repaired = await pool.query<{ target_spec_id: string | null; is_broken: boolean }>(
      `SELECT target_spec_id, is_broken FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [cloneId]
    );
    expect(repaired.rows[0]?.is_broken).toBe(false);
    expect(repaired.rows[0]?.target_spec_id).toBe(added.specId);
    const masterRef = await pool.query<{ target_spec_id: string | null }>(
      `SELECT target_spec_id FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [masterId]
    );
    expect(masterRef.rows[0]?.target_spec_id).toBeNull();
  });

  it('duplicate section in project → pg 23505 (409 at the API layer)', async () => {
    await expect(addSectionToProject(projectId, '03 30 00', pool)).rejects.toSatisfy(
      (err: unknown) => getPgCode(err) === '23505'
    );
  });
});

describe('addSectionToProject — resolution', () => {
  it('fallback: section absent from client master (priority 1) resolves from company master (priority 2)', async () => {
    const projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '09 91 00', pool);
    expect(result.source.libraryId).toBe(companyLib);
    expect(result.shadowed).toBeUndefined();
  });

  it('shadow advisory: section in both sources → winner is priority 1, shadowed lists the other', async () => {
    const projectId = await newProject([clientLib, companyLib]);
    const result = await addSectionToProject(projectId, '04 20 00', pool);
    expect(result.source.libraryId).toBe(clientLib);
    expect(result.shadowed).toEqual([{ libraryId: companyLib, name: `Derive Co ${suffix}` }]);
  });

  it('no source holds the section → SectionUnresolvedError', async () => {
    const projectId = await newProject([clientLib]);
    await expect(addSectionToProject(projectId, '99 99 99', pool)).rejects.toBeInstanceOf(
      SectionUnresolvedError
    );
  });

  it('unknown project → ProjectNotFoundError', async () => {
    await expect(
      addSectionToProject('00000000-0000-0000-0000-000000000000', '03 30 00', pool)
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('removeSectionFromProject', () => {
  it('clean clone (content_version = 1) deletes freely: spec, paragraphs, TOC row gone; master intact', async () => {
    const projectId = await newProject([companyLib]);
    const { specId } = await addSectionToProject(projectId, '03 30 00', pool);
    const outcome = await removeSectionFromProject(projectId, specId, false, pool);
    expect(outcome).toBe('removed');
    const counts = await pool.query<{ specs: string; paras: string; toc: string }>(
      `SELECT
         (SELECT COUNT(*) FROM specs WHERE id = $1) AS specs,
         (SELECT COUNT(*) FROM paragraphs WHERE spec_id = $1) AS paras,
         (SELECT COUNT(*) FROM project_specs WHERE spec_id = $1) AS toc`,
      [specId]
    );
    expect(counts.rows[0]).toEqual({ specs: '0', paras: '0', toc: '0' });
    const master = await pool.query(`SELECT 1 FROM specs WHERE id = $1`, [masterId]);
    expect(master.rowCount).toBe(1);
  });

  it('edited clone (content_version > 1) → blocked without force; force=true deletes', async () => {
    const projectId = await newProject([companyLib]);
    const { specId } = await addSectionToProject(projectId, '03 30 00', pool);
    await pool.query(`UPDATE specs SET content_version = 2 WHERE id = $1`, [specId]);
    expect(await removeSectionFromProject(projectId, specId, false, pool)).toBe('edited');
    // blocked removal left everything in place
    const still = await pool.query(`SELECT 1 FROM project_specs WHERE spec_id = $1`, [specId]);
    expect(still.rowCount).toBe(1);
    expect(await removeSectionFromProject(projectId, specId, true, pool)).toBe('removed');
  });

  it('spec not owned by this project (a master id) → not-found', async () => {
    const projectId = await newProject([companyLib]);
    expect(await removeSectionFromProject(projectId, masterId, false, pool)).toBe('not-found');
  });

  it('broken-ref marking for other project specs that referenced the removed clone is preserved', async () => {
    const projectId = await newProject([companyLib]);
    const a = await addSectionToProject(projectId, '03 30 00', pool); // refs 09 91 00
    const b = await addSectionToProject(projectId, '09 91 00', pool);
    const outcome = await removeSectionFromProject(projectId, b.specId, false, pool);
    expect(outcome).toBe('removed');
    const ref = await pool.query<{ is_broken: boolean; target_spec_id: string | null }>(
      `SELECT is_broken, target_spec_id FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section'`,
      [a.specId]
    );
    expect(ref.rows[0]?.is_broken).toBe(true);
    expect(ref.rows[0]?.target_spec_id).toBeNull(); // FK SET NULL on spec delete
  });

  it('spec in a design package → in-package (regardless of force)', async () => {
    const projectId = await newProject([companyLib]);
    const { specId } = await addSectionToProject(projectId, '03 30 00', pool);
    // raw insert: design package + membership — mirrors the packages.ts query layer
    const pkg = await pool.query<{ id: string }>(
      `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
      [projectId, `guard-test-${specId.slice(0, 8)}`]
    );
    const pkgId = pkg.rows[0]?.id;
    if (!pkgId) throw new Error('package insert failed');
    await pool.query(
      `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, 1)`,
      [pkgId, specId]
    );
    expect(await removeSectionFromProject(projectId, specId, false, pool)).toBe('in-package');
    expect(await removeSectionFromProject(projectId, specId, true, pool)).toBe('in-package');
    // cleanup: package cascades package_specs; spec can then be removed
    await pool.query('DELETE FROM design_packages WHERE id = $1', [pkgId]);
    expect(await removeSectionFromProject(projectId, specId, false, pool)).toBe('removed');
  });
});
