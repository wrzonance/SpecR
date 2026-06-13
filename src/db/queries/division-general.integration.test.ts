import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool } from '../index.js';
import {
  getLibraryDivisionGeneralSpec,
  getProjectDivisionGeneralSpec,
  setLibraryDivisionGeneralSpec,
  reconcileLibraryDivisionGeneralSpec,
  reconcileProjectDivisionGeneralSpec,
  DivisionGeneralSpecNotInScopeError,
} from './division-general.js';

const suffix = randomUUID().slice(0, 8);
const libraries: string[] = [];
const projects: string[] = [];

async function insertLibrary(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [`Division General ${name} ${suffix}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertLibrary failed');
  libraries.push(row.id);
  return row.id;
}

async function insertProject(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`Division General Project ${suffix}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProject failed');
  projects.push(row.id);
  return row.id;
}

async function insertLibrarySpec(
  libraryId: string,
  section: string,
  title: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, libraryId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertLibrarySpec failed');
  return row.id;
}

async function insertProjectSpec(
  projectId: string,
  section: string,
  title: string
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, projectId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProjectSpec failed');
  return row.id;
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

describe('division general spec resolution', () => {
  it('auto-resolves and persists exact NN 00 00 when present in a library', async () => {
    const libraryId = await insertLibrary('exact');
    const exactId = await insertLibrarySpec(libraryId, '27 00 00', 'Communications General');
    await insertLibrarySpec(libraryId, '27 10 00', 'Cabling');

    const result = await getLibraryDivisionGeneralSpec(libraryId, '27');

    expect(result).toMatchObject({
      status: 'resolved',
      detectionMethod: 'exact_section',
      expectedSection: '27 00 00',
      generalSpec: { specId: exactId, section: '27 00 00' },
      candidates: [],
    });
    const row = await pool.query<{ detection_method: string }>(
      `SELECT detection_method FROM division_general_specs
       WHERE library_id = $1 AND division = '27'`,
      [libraryId]
    );
    expect(row.rows[0]).toEqual({ detection_method: 'exact_section' });
  });

  it('missing exact section returns ranked advisory candidates without persisting fallback', async () => {
    const libraryId = await insertLibrary('missing');
    const firstId = await insertLibrarySpec(libraryId, '27 05 26', 'Grounding and Bonding');
    const keywordId = await insertLibrarySpec(
      libraryId,
      '27 10 00',
      'Common Work Results for Communications'
    );

    const result = await getLibraryDivisionGeneralSpec(libraryId, '27');

    expect(result?.status).toBe('missing');
    expect(result?.generalSpec).toBeNull();
    expect(result?.message).toContain('No 27 00 00 spec exists');
    expect(result?.candidates).toEqual([
      expect.objectContaining({
        specId: keywordId,
        rank: 1,
        reason: 'title_keyword',
        confidence: 'medium',
      }),
      expect.objectContaining({
        specId: firstId,
        rank: 2,
        reason: 'first_in_division',
        confidence: 'low',
      }),
    ]);
    const persisted = await pool.query(
      `SELECT 1 FROM division_general_specs WHERE library_id = $1 AND division = '27'`,
      [libraryId]
    );
    expect(persisted.rowCount).toBe(0);
  });

  it('manual assignment wins and automatic exact reconciliation does not overwrite it', async () => {
    const libraryId = await insertLibrary('manual');
    const manualId = await insertLibrarySpec(libraryId, '27 10 00', 'Cabling');
    await setLibraryDivisionGeneralSpec(libraryId, '27', {
      generalSpecId: manualId,
      notes: 'Owner issues 27 00 00 separately.',
    });
    await insertLibrarySpec(libraryId, '27 00 00', 'Communications General');

    await reconcileLibraryDivisionGeneralSpec(libraryId, '27 00 00', pool);
    const result = await getLibraryDivisionGeneralSpec(libraryId, '27');

    expect(result).toMatchObject({
      status: 'resolved',
      detectionMethod: 'manual',
      notes: 'Owner issues 27 00 00 separately.',
      generalSpec: { specId: manualId, section: '27 10 00' },
    });
  });

  it('manual not_applicable records an explicit no-in-scope-general decision', async () => {
    const libraryId = await insertLibrary('not-applicable');
    await insertLibrarySpec(libraryId, '27 10 00', 'Cabling');

    const result = await setLibraryDivisionGeneralSpec(libraryId, '27', {
      status: 'not_applicable',
      notes: 'General requirements issued by another consultant.',
    });

    expect(result).toMatchObject({
      status: 'not_applicable',
      detectionMethod: 'manual',
      generalSpec: null,
      candidates: [],
      notes: 'General requirements issued by another consultant.',
    });
  });

  it('manual assignment rejects specs outside the owner scope or requested division', async () => {
    const libraryId = await insertLibrary('invalid-a');
    const otherLibraryId = await insertLibrary('invalid-b');
    const wrongDivisionId = await insertLibrarySpec(libraryId, '28 00 00', 'Electronic Safety');
    const wrongOwnerId = await insertLibrarySpec(otherLibraryId, '27 00 00', 'Other Owner');

    await expect(
      setLibraryDivisionGeneralSpec(libraryId, '27', { generalSpecId: wrongDivisionId })
    ).rejects.toBeInstanceOf(DivisionGeneralSpecNotInScopeError);
    await expect(
      setLibraryDivisionGeneralSpec(libraryId, '27', { generalSpecId: wrongOwnerId })
    ).rejects.toBeInstanceOf(DivisionGeneralSpecNotInScopeError);
  });

  it('project-scope reconciliation auto-resolves exact NN 00 00 independently of libraries', async () => {
    const projectId = await insertProject();
    const exactId = await insertProjectSpec(
      projectId,
      '27 00 00',
      'Project Communications General'
    );
    await insertProjectSpec(projectId, '27 10 00', 'Project Cabling');

    await reconcileProjectDivisionGeneralSpec(projectId, '27 10 00', pool);
    const result = await getProjectDivisionGeneralSpec(projectId, '27');

    expect(result).toMatchObject({
      scope: 'project',
      ownerId: projectId,
      status: 'resolved',
      detectionMethod: 'exact_section',
      generalSpec: { specId: exactId, section: '27 00 00' },
    });
  });
});
