import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  createLibrary,
  findLibraryById,
  findLibraryByName,
  listLibraries,
  UFGS_REFERENCE_LIBRARY,
  DEFAULT_COMPANY_LIBRARY,
} from './libraries.js';

// Per-run suffix so this suite's client-library names cannot collide with a
// leftover row from a prior run that skipped its afterEach (process kill,
// hookTimeout). See issue #623.
const suffix = randomUUID().slice(0, 8);

// Namespaces reserved by this file: '99 77 %' spec sections, project
// 'lib-xor-test-project', and every non-built-in library row.
// Cleanup order is FK-safe: specs → projects → libraries.
afterEach(async () => {
  await pool.query(`DELETE FROM specs WHERE section LIKE '99 77 %'`);
  await pool.query(`DELETE FROM projects WHERE name = 'lib-xor-test-project'`);
  await pool.query(`DELETE FROM libraries WHERE name NOT IN ($1, $2)`, [
    UFGS_REFERENCE_LIBRARY,
    DEFAULT_COMPANY_LIBRARY,
  ]);
});

describe('migration 016 — backfill and built-ins', () => {
  it('db: no spec is ownerless after backfill', async () => {
    const r = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM specs WHERE library_id IS NULL AND project_id IS NULL`
    );
    expect(r.rows[0]).toMatchObject({ n: 0 });
  });

  it('db: built-in libraries exist with the documented tiers', async () => {
    const ufgs = await findLibraryByName(UFGS_REFERENCE_LIBRARY);
    expect(ufgs).toMatchObject({ tier: 'reference', owner: null });
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    expect(company).toMatchObject({ tier: 'company', owner: null });
  });
});

describe('libraries CRUD', () => {
  it('createLibrary → findLibraryById round-trips a client master with parent lineage', async () => {
    const acmeName = `Acme Client Master ${suffix}`;
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    const created = await createLibrary({
      tier: 'client',
      name: acmeName,
      owner: 'Acme Corp',
      parentLibraryId: company!.id,
    });
    const found = await findLibraryById(created.id);
    expect(found).toMatchObject({
      tier: 'client',
      name: acmeName,
      owner: 'Acme Corp',
      parentLibraryId: company!.id,
    });
  });

  it('listLibraries includes the built-ins', async () => {
    const all = await listLibraries();
    const names = all.map((l) => l.name);
    expect(names).toContain(UFGS_REFERENCE_LIBRARY);
    expect(names).toContain(DEFAULT_COMPANY_LIBRARY);
  });

  it('db: tier CHECK rejects an unknown tier', async () => {
    await expect(
      pool.query(`INSERT INTO libraries (tier, name) VALUES ('project', 'Bad Tier')`)
    ).rejects.toThrow(/libraries_tier_check/);
  });

  it('db: library names are unique', async () => {
    await expect(
      pool.query(`INSERT INTO libraries (tier, name) VALUES ('company', $1)`, [
        DEFAULT_COMPANY_LIBRARY,
      ])
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('specs ownership — ADR-015 D1', () => {
  it('db: the same (section, source) coexists in two libraries without conflict (#92)', async () => {
    const other = await createLibrary({ tier: 'client', name: `Second Library ${suffix}` });
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    await pool.query(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 01', 'Copy A', 'arcat', $1)`,
      [company!.id]
    );
    const r = await pool.query(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 01', 'Copy B', 'arcat', $1) RETURNING id`,
      [other.id]
    );
    expect(r.rows).toHaveLength(1);
  });

  it('db: duplicate (section, source) within one library is rejected', async () => {
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    await pool.query(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 02', 'First', 'arcat', $1)`,
      [company!.id]
    );
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 02', 'Second', 'arcat', $1)`,
        [company!.id]
      )
    ).rejects.toThrow(/specs_section_source_library_unique/);
  });

  it('db: XOR rejects a spec with both library_id and project_id', async () => {
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('lib-xor-test-project') RETURNING id`
    );
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source, library_id, project_id)
         VALUES ('99 77 03', 'Both Owners', 'arcat', $1, $2)`,
        [company!.id, proj.rows[0]!.id]
      )
    ).rejects.toThrow(/specs_owner_xor/);
  });

  it('db: XOR rejects a spec with neither owner', async () => {
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source) VALUES ('99 77 04', 'No Owner', 'arcat')`
      )
    ).rejects.toThrow(/specs_owner_xor/);
  });

  it('db: duplicate (section, project_id) is rejected for project copies', async () => {
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('lib-xor-test-project') RETURNING id`
    );
    const projectId = proj.rows[0]!.id;
    await pool.query(
      `INSERT INTO specs (section, title, source, project_id) VALUES ('99 77 05', 'Project Copy', 'arcat', $1)`,
      [projectId]
    );
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source, project_id) VALUES ('99 77 05', 'Dup Copy', 'arcat', $1)`,
        [projectId]
      )
    ).rejects.toThrow(/specs_section_project_unique/);
  });
});
