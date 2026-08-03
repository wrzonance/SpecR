import { afterEach, describe, expect, it } from 'vitest';
import { pool, DatabaseError } from '../index.js';
import { createLibrary } from './libraries.js';
import { createPackage } from './packages.js';
import { createPackageRevision } from './revisions.js';
import { upsertHeaderFooterConfig } from './header-footer.js';
import {
  resolveSpecGenerationContext,
  resolveProjectManualHeaderFooterContext,
  resolveRevisionHeaderFooterContext,
} from './header-footer-context.js';
import type { RevisionHeaderFooterFieldSource } from './header-footer-context.js';

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

async function insertProject(name: string, sectionNumberFormat = 'canonical'): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description, section_number_format) VALUES ($1, $2, $3) RETURNING id`,
    [name, 'header/footer context test', sectionNumberFormat]
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

describe('resolveSpecGenerationContext', () => {
  it('orphan spec (no owning project) → both fields null', async () => {
    const specId = await insertSpec('09 92 26.01');
    await expect(resolveSpecGenerationContext(specId)).resolves.toEqual({
      sectionNumberFormat: null,
      headerFooter: null,
    });
  });

  it('ambiguously owned spec (2+ projects) → both fields null', async () => {
    const specId = await insertSpec('09 92 26.02');
    const p1 = await insertProject(`${TEST_PREFIX}g1`, 'dots');
    const p2 = await insertProject(`${TEST_PREFIX}g2`, 'compact');
    await attachSpecToProject(p1, specId);
    await attachSpecToProject(p2, specId);
    await expect(resolveSpecGenerationContext(specId)).resolves.toEqual({
      sectionNumberFormat: null,
      headerFooter: null,
    });
  });

  it('sole project with no configured layers → format still resolves, header/footer null', async () => {
    const specId = await insertSpec('09 92 26.03');
    const projectId = await insertProject(`${TEST_PREFIX}g3`, 'dots');
    await attachSpecToProject(projectId, specId);
    await expect(resolveSpecGenerationContext(specId)).resolves.toEqual({
      sectionNumberFormat: 'dots',
      headerFooter: null,
    });
  });

  // Regression (CodeRabbit, PR #479): the section-number format AND the
  // header/footer must both come from the SAME sole-owning-project snapshot —
  // proven here by a single project owning the spec, whose format and
  // projectName are read back together in one resolution.
  it('sole project with a configured layer → format and header/footer come from one snapshot', async () => {
    const specId = await insertSpec('09 92 26.04');
    const projectId = await insertProject(`${TEST_PREFIX}g4`, 'compact');
    await attachSpecToProject(projectId, specId);
    await upsertHeaderFooterConfig(
      { projectId },
      { footer: { right: { content: [{ kind: 'pageNumber' }] } } }
    );

    const context = await resolveSpecGenerationContext(specId);

    expect(context.sectionNumberFormat).toBe('compact');
    expect(context.headerFooter?.fieldValues.projectName).toBe(`${TEST_PREFIX}g4`);
    expect(context.headerFooter?.composition).toEqual({
      footer: { right: { content: [{ kind: 'pageNumber' }] } },
    });
  });
});

async function insertRevisionScope(
  projectSuffix: string
): Promise<{ projectId: string; packageId: string; revisionId: string }> {
  const projectId = await insertProject(`${TEST_PREFIX}${projectSuffix}`);
  const pkg = await createPackage(projectId, `${TEST_PREFIX}${projectSuffix}-pkg`, pool);
  const revision = await createPackageRevision(
    pkg.packageId,
    { label: `${TEST_PREFIX}${projectSuffix}-rev` },
    pool
  );
  return { projectId, packageId: pkg.packageId, revisionId: revision.revisionId };
}

const FIELD_SOURCE: RevisionHeaderFooterFieldSource = {
  projectName: 'Caller-Supplied Project',
  packageName: 'Caller-Supplied Package',
  revisionName: 'Caller-Supplied Revision',
  revisionLabel: 'Caller-Supplied Label',
};

describe('resolveProjectManualHeaderFooterContext', () => {
  it('I1: project with zero configured header/footer layers resolves to null, not an empty composition', async () => {
    const projectId = await insertProject(`${TEST_PREFIX}pm1`);
    await expect(
      resolveProjectManualHeaderFooterContext(projectId, `${TEST_PREFIX}pm1`)
    ).resolves.toBeNull();
  });

  it('resolves composition + projectName under a configured project layer', async () => {
    const projectId = await insertProject(`${TEST_PREFIX}pm2`);
    await upsertHeaderFooterConfig(
      { projectId },
      { footer: { right: { content: [{ kind: 'pageNumber' }] } } }
    );

    const context = await resolveProjectManualHeaderFooterContext(projectId, `${TEST_PREFIX}pm2`);

    expect(context?.composition).toEqual({
      footer: { right: { content: [{ kind: 'pageNumber' }] } },
    });
    expect(context?.fieldValues).toEqual({ projectName: `${TEST_PREFIX}pm2` });
  });

  it('I3: a genuine database failure propagates as DatabaseError, not swallowed', async () => {
    await expect(
      resolveProjectManualHeaderFooterContext('not-a-valid-uuid', 'irrelevant')
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('resolveRevisionHeaderFooterContext', () => {
  it('I1: revision with zero configured header/footer layers anywhere in its chain resolves to null', async () => {
    const { revisionId } = await insertRevisionScope('rv1');
    await expect(resolveRevisionHeaderFooterContext(revisionId, FIELD_SOURCE)).resolves.toBeNull();
  });

  it('a revision that does not exist resolves to null rather than throwing', async () => {
    await expect(
      resolveRevisionHeaderFooterContext('00000000-0000-0000-0000-000000000000', FIELD_SOURCE)
    ).resolves.toBeNull();
  });

  // fieldSource values are threaded verbatim from the caller's own
  // RevisionManualData snapshot, never re-derived from a second DB read —
  // deliberately mismatched from the real project/package/revision names so
  // an internal re-query would be caught by this assertion.
  it('fieldSource values are threaded verbatim, never re-queried from the DB', async () => {
    const { revisionId } = await insertRevisionScope('rv2');
    await upsertHeaderFooterConfig(
      { revisionId },
      { header: { left: { content: [{ kind: 'revisionLabel' }] } } }
    );

    const context = await resolveRevisionHeaderFooterContext(revisionId, FIELD_SOURCE);

    expect(context?.fieldValues).toEqual(FIELD_SOURCE);
  });

  it('resolves clientName from the client tier alongside the threaded fieldSource', async () => {
    const company = await createLibrary({ tier: 'company', name: `${TEST_PREFIX}rv-company` });
    const client = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}rv-client`,
      parentLibraryId: company.id,
    });
    const { projectId, revisionId } = await insertRevisionScope('rv3');
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
      [projectId, client.id]
    );
    await upsertHeaderFooterConfig(
      { revisionId },
      { header: { center: { content: [{ kind: 'clientName' }] } } }
    );

    const context = await resolveRevisionHeaderFooterContext(revisionId, FIELD_SOURCE);

    expect(context?.fieldValues).toEqual({
      ...FIELD_SOURCE,
      clientName: `${TEST_PREFIX}rv-client`,
    });
  });

  // Cascade precedence: resolveHeaderFooterConfig merges client < project <
  // package < revision, so a revision-level layer wins over a project-level
  // layer for the same key while an unconflicting project-level key survives.
  it('cascade precedence: revision layer overrides project layer for the same key, project-only keys survive', async () => {
    const { projectId, revisionId } = await insertRevisionScope('rv4');
    await upsertHeaderFooterConfig(
      { projectId },
      {
        header: {
          left: { content: [{ kind: 'pageNumber' }] },
          right: { content: [{ kind: 'projectName' }] },
        },
      }
    );
    await upsertHeaderFooterConfig(
      { revisionId },
      { header: { left: { content: [{ kind: 'literal', text: 'Revision Wins' }] } } }
    );

    const context = await resolveRevisionHeaderFooterContext(revisionId, FIELD_SOURCE);

    expect(context?.composition).toEqual({
      header: {
        left: { content: [{ kind: 'literal', text: 'Revision Wins' }] },
        right: { content: [{ kind: 'projectName' }] },
      },
    });
  });

  it('I3: a genuine database failure propagates as DatabaseError, not swallowed', async () => {
    await expect(
      resolveRevisionHeaderFooterContext('not-a-valid-uuid', FIELD_SOURCE)
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
