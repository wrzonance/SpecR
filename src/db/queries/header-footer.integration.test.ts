import { afterEach, describe, expect, it } from 'vitest';
import { pool } from '../index.js';
import { HEADER_FOOTER_JSON_BODY_LIMIT_BYTES } from '../../lib/header-footer-body-limit.js';
import { createLibrary } from './libraries.js';
import {
  deleteHeaderFooterConfig,
  findHeaderFooterConfig,
  HeaderFooterScopeError,
  HeaderFooterValidationError,
  resolveHeaderFooterConfig,
  upsertHeaderFooterConfig,
} from './header-footer.js';

const TEST_PREFIX = 'hf-test-';

interface ScopeFixture {
  readonly clientLibraryId: string;
  readonly companyLibraryId: string;
  readonly projectId: string;
  readonly packageId: string;
  readonly revisionId: string;
}

async function insertProject(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [`${TEST_PREFIX}project-${Date.now()}`, 'Header/footer composition test']
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertProject: no project id returned');
  return row.id;
}

async function insertPackage(projectId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position)
     VALUES ($1, $2, 1) RETURNING id`,
    [projectId, `${TEST_PREFIX}package-${Date.now()}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertPackage: no package id returned');
  return row.id;
}

async function insertRevision(packageId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO package_revisions
       (package_id, label, revision_type, revision_date, sort_order, attributes)
     VALUES ($1, 'Addendum 1', 'addendum', '2026-06-18'::date, 1, '{"number":1}'::jsonb)
     RETURNING id`,
    [packageId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertRevision: no revision id returned');
  return row.id;
}

async function makeScopeFixture(): Promise<ScopeFixture> {
  const company = await createLibrary({
    tier: 'company',
    name: `${TEST_PREFIX}company-${Date.now()}`,
  });
  const client = await createLibrary({
    tier: 'client',
    name: `${TEST_PREFIX}client-${Date.now()}`,
    parentLibraryId: company.id,
  });
  const projectId = await insertProject();
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority)
     VALUES ($1, $2, 1), ($1, $3, 2)`,
    [projectId, client.id, company.id]
  );
  const packageId = await insertPackage(projectId);
  const revisionId = await insertRevision(packageId);
  return {
    clientLibraryId: client.id,
    companyLibraryId: company.id,
    projectId,
    packageId,
    revisionId,
  };
}

afterEach(async () => {
  // No explicit `header_footer_configs` delete: that table's `scope_xor` CHECK
  // forces exactly ONE of client_library_id/project_id/package_id/revision_id
  // to be non-null, and all four FKs are `ON DELETE CASCADE` — so every row
  // this file creates is necessarily owned by, and removed with, one of the
  // rows deleted below. A whole-table wipe here would also destroy a
  // concurrent invocation's rows (#638/ADR-090) for no benefit (#442).
  await pool.query(
    `DELETE FROM package_revisions
     WHERE package_id IN (SELECT id FROM design_packages WHERE name LIKE $1)`,
    [`${TEST_PREFIX}%`]
  );
  await pool.query(`DELETE FROM design_packages WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM projects WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
  await pool.query(`DELETE FROM libraries WHERE name LIKE $1`, [`${TEST_PREFIX}%`]);
});

describe('header_footer_configs query surface', () => {
  it('upsert/find/delete round-trips an open composition payload at a client scope', async () => {
    const fixture = await makeScopeFixture();
    const config = {
      header: {
        left: { content: [{ kind: 'clientName' }] },
        center: { content: [{ kind: 'projectNumber', fallback: 'name' }] },
        style: { fontFamily: 'Arial', fontSizeHalfPt: 18, clientToken: 'acme' },
        ruleLine: { enabled: true, widthTwips: 8, futureRule: { colorMode: 'theme' } },
      },
      footer: {
        right: { content: [{ kind: 'pageNumber', label: 'Page' }] },
      },
      vendorExtension: { layoutPreset: 'client-a' },
    };

    const created = await upsertHeaderFooterConfig(
      { clientLibraryId: fixture.clientLibraryId },
      config
    );
    const found = await findHeaderFooterConfig({ clientLibraryId: fixture.clientLibraryId });

    expect(found?.id).toBe(created.id);
    expect(found?.config).toEqual(config);
    expect(found?.scope).toEqual({ kind: 'client', clientLibraryId: fixture.clientLibraryId });

    await expect(
      deleteHeaderFooterConfig({ clientLibraryId: fixture.clientLibraryId })
    ).resolves.toBe(true);
    await expect(
      findHeaderFooterConfig({ clientLibraryId: fixture.clientLibraryId })
    ).resolves.toBe(null);
  });

  it('resolves client → project → package → revision configs with deep object overrides', async () => {
    const fixture = await makeScopeFixture();
    await upsertHeaderFooterConfig(
      { clientLibraryId: fixture.clientLibraryId },
      {
        header: {
          left: { content: [{ kind: 'clientName' }] },
          center: { content: [{ kind: 'projectName' }] },
          style: { fontFamily: 'Arial', fontSizeHalfPt: 18 },
          ruleLine: { enabled: true, color: '111111' },
        },
        footer: {
          left: { content: [{ kind: 'projectNumber' }] },
          right: { content: [{ kind: 'pageNumber' }] },
        },
      }
    );
    await upsertHeaderFooterConfig(
      { projectId: fixture.projectId },
      {
        header: {
          center: {
            content: [
              { kind: 'sectionNumber' },
              { kind: 'literal', text: ' - ' },
              { kind: 'sectionTitle' },
            ],
          },
          style: { fontSizeHalfPt: 20 },
        },
      }
    );
    await upsertHeaderFooterConfig(
      { packageId: fixture.packageId },
      {
        footer: {
          left: { content: [{ kind: 'packageName' }] },
          right: { content: [{ kind: 'pageNumber', format: 'PAGE {page}' }] },
        },
      }
    );
    await upsertHeaderFooterConfig(
      { revisionId: fixture.revisionId },
      {
        header: {
          right: { content: [{ kind: 'revisionLabel' }] },
          style: { fontFamily: 'Aptos' },
        },
        footer: {
          left: { content: [{ kind: 'revisionName' }] },
        },
      }
    );

    const resolved = await resolveHeaderFooterConfig({ revisionId: fixture.revisionId });

    expect(resolved?.context).toEqual({
      clientLibraryId: fixture.clientLibraryId,
      projectId: fixture.projectId,
      packageId: fixture.packageId,
      revisionId: fixture.revisionId,
    });
    expect(resolved?.layers.map((layer) => layer.scope.kind)).toEqual([
      'client',
      'project',
      'package',
      'revision',
    ]);
    expect(resolved?.config).toEqual({
      header: {
        left: { content: [{ kind: 'clientName' }] },
        center: {
          content: [
            { kind: 'sectionNumber' },
            { kind: 'literal', text: ' - ' },
            { kind: 'sectionTitle' },
          ],
        },
        right: { content: [{ kind: 'revisionLabel' }] },
        style: { fontFamily: 'Aptos', fontSizeHalfPt: 20 },
        ruleLine: { enabled: true, color: '111111' },
      },
      footer: {
        left: { content: [{ kind: 'revisionName' }] },
        right: { content: [{ kind: 'pageNumber', format: 'PAGE {page}' }] },
      },
    });
  });

  it('resolves layers whose MERGED size exceeds the write transport limit without erroring (#490 follow-up — structural read, not a write)', async () => {
    // Two independently-valid layers, each within the per-write transport
    // budget, whose deep-merge exceeds HEADER_FOOTER_JSON_BODY_LIMIT_BYTES.
    // Pre-fix the resolution re-parse (mergeConfigs → parseConfig) enforced the
    // WRITE budget on the merged READ and threw HeaderFooterValidationError, so
    // resolveHeaderFooterConfigCore 500'd on data that was legitimately stored.
    // The invariant now lives on the write schema only; the structural
    // resolution read must tolerate the merged overage.
    const fixture = await makeScopeFixture();
    const nearHalfBudget = 'A'.repeat(Math.floor(HEADER_FOOTER_JSON_BODY_LIMIT_BYTES * 0.6));
    await upsertHeaderFooterConfig(
      { clientLibraryId: fixture.clientLibraryId },
      { header: { left: { content: [{ kind: 'clientName' }] } }, clientLogo: nearHalfBudget }
    );
    await upsertHeaderFooterConfig(
      { projectId: fixture.projectId },
      { footer: { left: { content: [{ kind: 'projectNumber' }] } }, projectLogo: nearHalfBudget }
    );

    const resolved = await resolveHeaderFooterConfig({ projectId: fixture.projectId });

    expect(resolved?.config['clientLogo']).toBe(nearHalfBudget);
    expect(resolved?.config['projectLogo']).toBe(nearHalfBudget);
  });

  it('rejects invalid composition fields and non-client library scopes at the write boundary', async () => {
    const fixture = await makeScopeFixture();

    await expect(
      upsertHeaderFooterConfig(
        { clientLibraryId: fixture.clientLibraryId },
        { footer: { right: { content: [{ kind: 'pageCounter' }] } } }
      )
    ).rejects.toBeInstanceOf(HeaderFooterValidationError);

    await expect(
      upsertHeaderFooterConfig(
        { clientLibraryId: fixture.companyLibraryId },
        { header: { left: { content: [{ kind: 'clientName' }] } } }
      )
    ).rejects.toBeInstanceOf(HeaderFooterScopeError);
  });
});
