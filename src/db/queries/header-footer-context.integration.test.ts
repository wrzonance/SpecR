import { afterEach, describe, expect, it } from 'vitest';
import { pool, DatabaseError } from '../index.js';
import { createLibrary } from './libraries.js';
import { upsertHeaderFooterConfig } from './header-footer.js';
import { resolveSpecHeaderFooterContext } from './header-footer-context.js';

const TEST_PREFIX = 'hfctx-test-';

async function insertSpec(section: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    [section, `${TEST_PREFIX}spec-${section}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertSpec: no spec id returned');
  return row.id;
}

async function insertProject(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [name, 'header/footer context test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProject: no project id returned');
  return row.id;
}

async function attachSpecToProject(projectId: string, specId: string): Promise<void> {
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
}

afterEach(async () => {
  await pool.query(`DELETE FROM header_footer_configs`);
  await pool.query(
    `DELETE FROM project_specs WHERE project_id IN (SELECT id FROM projects WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM specs WHERE title LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

describe('resolveSpecHeaderFooterContext', () => {
  it('I2: orphan spec (no owning project) resolves to null', async () => {
    const specId = await insertSpec('09 91 26.01');
    await expect(resolveSpecHeaderFooterContext(specId)).resolves.toBeNull();
  });

  it('I2: ambiguously owned spec (2+ projects) resolves to null', async () => {
    const specId = await insertSpec('09 91 26.02');
    const p1 = await insertProject(`${TEST_PREFIX}p1`);
    const p2 = await insertProject(`${TEST_PREFIX}p2`);
    await attachSpecToProject(p1, specId);
    await attachSpecToProject(p2, specId);
    await expect(resolveSpecHeaderFooterContext(specId)).resolves.toBeNull();
  });

  it('I1: sole project with zero configured header/footer layers resolves to null, not an empty composition', async () => {
    const specId = await insertSpec('09 91 26.03');
    const projectId = await insertProject(`${TEST_PREFIX}p3`);
    await attachSpecToProject(projectId, specId);
    await expect(resolveSpecHeaderFooterContext(specId)).resolves.toBeNull();
  });

  it('resolves composition + projectName/clientName for a sole project under a configured client layer', async () => {
    const company = await createLibrary({ tier: 'company', name: `${TEST_PREFIX}company` });
    const client = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}client`,
      parentLibraryId: company.id,
    });
    const specId = await insertSpec('09 91 26.04');
    const projectId = await insertProject(`${TEST_PREFIX}p4`);
    await attachSpecToProject(projectId, specId);
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
      [projectId, client.id]
    );
    await upsertHeaderFooterConfig(
      { clientLibraryId: client.id },
      { header: { left: { content: [{ kind: 'clientName' }] } } }
    );

    const context = await resolveSpecHeaderFooterContext(specId);

    expect(context?.composition).toEqual({
      header: { left: { content: [{ kind: 'clientName' }] } },
    });
    expect(context?.fieldValues).toEqual({
      projectName: `${TEST_PREFIX}p4`,
      clientName: `${TEST_PREFIX}client`,
    });
  });

  it('I9: no client source on the project chain omits clientName rather than throwing', async () => {
    const specId = await insertSpec('09 91 26.05');
    const projectId = await insertProject(`${TEST_PREFIX}p5`);
    await attachSpecToProject(projectId, specId);
    await upsertHeaderFooterConfig(
      { projectId },
      { footer: { right: { content: [{ kind: 'pageNumber' }] } } }
    );

    const context = await resolveSpecHeaderFooterContext(specId);

    expect(context?.fieldValues.clientName).toBeUndefined();
    expect(context?.fieldValues.projectName).toBe(`${TEST_PREFIX}p5`);
  });

  it('I3: a genuine database failure propagates as DatabaseError, not swallowed', async () => {
    await expect(resolveSpecHeaderFooterContext('not-a-valid-uuid')).rejects.toBeInstanceOf(
      DatabaseError
    );
  });
});
