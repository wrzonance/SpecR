import { afterEach, describe, expect, it } from 'vitest';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { createLibrary } from './libraries.js';
import { upsertHeaderFooterConfig } from './header-footer.js';
import {
  resolveSpecHeaderFooterContext,
  resolveSpecGenerationContext,
} from './header-footer-context.js';

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

// Review finding: resolveClientName has two distinct undefined-producing
// paths — a null clientLibraryId and a non-null clientLibraryId whose
// library row no longer resolves. The schema makes the second path a
// genuine time-of-check/time-of-use race rather than a reachable steady
// state: contextForProject's client lookup is an INNER JOIN against
// libraries, so it can only ever return a clientLibraryId that existed at
// that exact query. This reproduces the race deterministically against real
// Postgres: every read still goes through the real pool, but the wrapper
// performs a genuine unlink+delete right before the one query
// (findLibraryById's `FROM libraries WHERE id`) that must observe the
// library as already gone.
function raceLibraryDeletionOnLookup(libraryId: string): { query: Pool['query'] } {
  // Every call site in header-footer-context.ts/header-footer.ts/libraries.ts
  // uses only the `(text: string, values: unknown[])` form of `db.query` —
  // never the QueryConfig/stream/callback overloads. Narrowing to that one
  // shape (rather than reproducing all of `Pool['query']`'s overloads for a
  // test double) needs one cast at the boundary, same as this suite's
  // existing `FAKE_POOL = {} as Pool` precedent (src/api/generate-header-footer.test.ts).
  const query = (async (text: string, values?: unknown[]): Promise<QueryResult<QueryResultRow>> => {
    if (text.includes('FROM libraries WHERE id')) {
      await pool.query('DELETE FROM project_sources WHERE library_id = $1', [libraryId]);
      await pool.query('DELETE FROM libraries WHERE id = $1', [libraryId]);
    }
    return pool.query(text, values);
  }) as Pool['query'];
  return { query };
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

  it('no client source on the project chain (null clientLibraryId) omits clientName rather than throwing', async () => {
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

  it('client library deleted between context resolution and name lookup (stale clientLibraryId) omits clientName rather than throwing', async () => {
    const company = await createLibrary({ tier: 'company', name: `${TEST_PREFIX}company-race` });
    const client = await createLibrary({
      tier: 'client',
      name: `${TEST_PREFIX}client-race`,
      parentLibraryId: company.id,
    });
    const specId = await insertSpec('09 91 26.06');
    const projectId = await insertProject(`${TEST_PREFIX}p6`);
    await attachSpecToProject(projectId, specId);
    await pool.query(
      `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
      [projectId, client.id]
    );
    await upsertHeaderFooterConfig(
      { projectId },
      { footer: { right: { content: [{ kind: 'pageNumber' }] } } }
    );

    const context = await resolveSpecHeaderFooterContext(
      specId,
      raceLibraryDeletionOnLookup(client.id)
    );

    expect(context?.fieldValues.clientName).toBeUndefined();
    expect(context?.fieldValues.projectName).toBe(`${TEST_PREFIX}p6`);
    const remaining = await pool.query('SELECT id FROM libraries WHERE id = $1', [client.id]);
    expect(remaining.rows).toHaveLength(0);
  });

  it('I3: a genuine database failure propagates as DatabaseError, not swallowed', async () => {
    await expect(resolveSpecHeaderFooterContext('not-a-valid-uuid')).rejects.toBeInstanceOf(
      DatabaseError
    );
  });
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
