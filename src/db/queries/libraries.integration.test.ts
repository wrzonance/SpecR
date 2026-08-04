import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  createLibrary,
  findLibraryById,
  findLibraryByName,
  listLibraries,
  UFGS_REFERENCE_LIBRARY,
  DEFAULT_COMPANY_LIBRARY,
} from './libraries.js';

// Per-run suffix on this suite's client-library names. Secondary to the
// beforeAll sweep below: it keeps concurrently-inspected rows attributable and
// avoids a hard unique-key failure if that sweep is ever narrowed. 32 bits, so
// it makes a collision improbable rather than impossible. See issue #623.
const suffix = randomUUID().slice(0, 8);

// Namespaces reserved by this file: '99 77 %' spec sections, project
// 'lib-xor-test-project', and every non-built-in library row — plus everything
// derived from those libraries. Deleting the library row alone is not enough
// once other suites own isolated fixture libraries (#631, #522): a run that
// dies before its own afterAll leaves master specs in real sections behind, and
// specs_library_id_fkey then makes the library undeletable, so this sweep — and
// with it the whole suite — fails in beforeAll on every subsequent run until
// the database is dropped by hand. That is the exact failure mode #623 exists
// to prevent, so the sweep clears the dependents too.
// Cleanup order is FK-safe: packages → membership → clones → projects →
// masters → sources → libraries.
async function clearReservedNamespaces(): Promise<void> {
  await pool.query(`DELETE FROM specs WHERE section LIKE '99 77 %'`);
  await pool.query(`DELETE FROM projects WHERE name = 'lib-xor-test-project'`);

  const doomed = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name NOT IN ($1, $2)`,
    [UFGS_REFERENCE_LIBRARY, DEFAULT_COMPANY_LIBRARY]
  );
  const libraryIds = doomed.rows.map((r) => r.id);
  if (libraryIds.length === 0) return;

  // Specs cloned out of a doomed library point back at its masters via
  // specs.parent_spec_id (NO ACTION), and project_specs/package_specs RESTRICT
  // the clones — so the whole derived project has to go before the masters can.
  const derived = await pool.query<{ project_id: string }>(
    `SELECT DISTINCT project_id FROM project_sources WHERE library_id = ANY($1)`,
    [libraryIds]
  );
  const projectIds = derived.rows.map((r) => r.project_id);
  if (projectIds.length > 0) {
    await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
    await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
    await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  }

  await pool.query('DELETE FROM specs WHERE library_id = ANY($1)', [libraryIds]);
  await pool.query('DELETE FROM project_sources WHERE library_id = ANY($1)', [libraryIds]);
  await pool.query('DELETE FROM libraries WHERE id = ANY($1)', [libraryIds]);
}

// Residue from a prior run that never reached its afterEach (process kill,
// hookTimeout) is cleared BEFORE the first test, not incidentally by the first
// test's teardown — so a filtered run (`-t`) starts as clean as a full one.
beforeAll(clearReservedNamespaces);
afterEach(clearReservedNamespaces);

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

describe('#623 regression — residue from a prior run is swept before the first test', () => {
  // The reported symptom was "run the suite twice against the same database and
  // libraries fails 11/11". The reachable path is a FILTERED run (`vitest -t`):
  // on a full run the afterEach sweep always precedes a colliding test, so the
  // leak is masked and the bug "does not reproduce". This test reproduces the
  // collision directly instead of shelling out to a nested filtered runner —
  // see the PR thread for why that mechanism was declined.
  it('libraries: leaked 99 77 residue collides on specs_section_source_library_unique until the reserved-namespace sweep clears it FK-first', async () => {
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);

    // Exactly what a run killed before its afterEach leaves behind: a
    // non-built-in library plus a spec row that references it.
    const leaked = await createLibrary({
      tier: 'client',
      name: `Leaked Residue ${randomUUID().slice(0, 8)}`,
      owner: 'Prior Run',
      parentLibraryId: company!.id,
    });
    await pool.query(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 42', 'Leaked', 'arcat', $1)`,
      [leaked.id]
    );

    // The symptom: the next run's insert collides with the leaked row.
    await expect(
      pool.query(
        `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 42', 'Fresh', 'arcat', $1)`,
        [leaked.id]
      )
    ).rejects.toThrow(/specs_section_source_library_unique/);

    // And why recovery used to mean dropping the database: the leaked library
    // cannot just be deleted while a spec still references it. FK order is the
    // load-bearing part of the sweep, not an incidental detail.
    await expect(pool.query(`DELETE FROM libraries WHERE id = $1`, [leaked.id])).rejects.toThrow(
      /specs_library_id_fkey/
    );

    // The sweep that beforeAll runs clears it, specs → projects → libraries.
    await clearReservedNamespaces();
    expect(await findLibraryById(leaked.id)).toBeNull();

    // The previously-colliding insert now succeeds — this is the state a
    // filtered run gets on a residue-carrying database once beforeAll sweeps.
    const fresh = await createLibrary({
      tier: 'client',
      name: `Post Sweep ${randomUUID().slice(0, 8)}`,
      owner: 'Fresh Run',
      parentLibraryId: company!.id,
    });
    const reinsert = await pool.query(
      `INSERT INTO specs (section, title, source, library_id) VALUES ('99 77 42', 'Fresh', 'arcat', $1) RETURNING id`,
      [fresh.id]
    );
    expect(reinsert.rows).toHaveLength(1);

    // The sweep must not take the built-ins with it.
    expect(await findLibraryByName(UFGS_REFERENCE_LIBRARY)).not.toBeNull();
    expect(await findLibraryByName(DEFAULT_COMPANY_LIBRARY)).not.toBeNull();
  });

  // Sibling suites now build isolated fixture libraries instead of borrowing
  // 'Default Company Master' (#631, #522). Their masters sit in REAL sections,
  // outside this file's '99 77 %' namespace, so a sweep that only cleared
  // '99 77 %' left them behind and then died on specs_library_id_fkey — taking
  // all 13 tests here down in beforeAll, on this run and every run after it.
  it('libraries: leaked fixture-library master in a real section does not wedge the reserved-namespace sweep on specs_library_id_fkey', async () => {
    const leaked = await createLibrary({
      tier: 'company',
      name: `Leaked Fixture Master ${randomUUID().slice(0, 8)}`,
    });
    await pool.query(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('05 12 00', 'Structural Steel Framing', 'unknown', $1)`,
      [leaked.id]
    );

    // Pre-fix behaviour: the bare library delete the sweep used to run.
    await expect(pool.query(`DELETE FROM libraries WHERE id = $1`, [leaked.id])).rejects.toThrow(
      /specs_library_id_fkey/
    );

    // The sweep clears the master first, so the library goes with it.
    await expect(clearReservedNamespaces()).resolves.toBeUndefined();
    expect(await findLibraryById(leaked.id)).toBeNull();
    expect(await findLibraryByName(UFGS_REFERENCE_LIBRARY)).not.toBeNull();
    expect(await findLibraryByName(DEFAULT_COMPANY_LIBRARY)).not.toBeNull();
  });

  // The test above proves the sweep is correct, but it calls the helper
  // directly — so it would still pass if the beforeAll registration were
  // deleted, which is the actual fix for #623. By the time any test in this
  // file executes, beforeAll has already run, so the pre-sweep state is not
  // observable from inside the suite and the wiring cannot be asserted
  // behaviourally without a nested runner. Pin it at the source instead, the
  // same way src/mcp/tool-schema-introspect.test.ts pins its own invariants.
  it('libraries: the reserved-namespace sweep is registered on beforeAll, not only afterEach', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./libraries.integration.test.ts', import.meta.url)),
      'utf8'
    );
    expect(source).toMatch(/beforeAll\(\s*clearReservedNamespaces\s*\)/);
    expect(source).toMatch(/afterEach\(\s*clearReservedNamespaces\s*\)/);
  });
});
