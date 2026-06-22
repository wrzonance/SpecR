import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { pool } from '../index.js';
import {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsSeedConflictError,
  type RequiredScope,
  type RequiredSectionInput,
} from './required-sections.js';

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  return r.rows[0]!.id;
}
async function newPackage(projectId: string, name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectId, name]
  );
  return r.rows[0]!.id;
}

let projectId: string;
const baseline = (): RequiredScope => ({ kind: 'baseline', projectId });

beforeAll(async () => {
  projectId = await newProject('req-sections-it');
});
afterEach(async () => {
  await pool.query(`DELETE FROM required_sections WHERE project_id = $1`, [projectId]);
});

describe('required_sections query layer', () => {
  it('replaces a scope and returns rows ordered by position', async () => {
    const rows = await setRequiredSections(baseline(), [
      { section: '03 30 00', title: 'Cast-in-Place Concrete' },
      { section: '09 91 00' },
    ]);
    expect(rows.map((r) => [r.section, r.position, r.title])).toEqual([
      ['03 30 00', 1, 'Cast-in-Place Concrete'],
      ['09 91 00', 2, null],
    ]);
    const read = await listRequiredSections(baseline());
    expect(read).toEqual(rows);
  });

  it('renumbers position on replace and isolates package scope from baseline', async () => {
    const packageId = await newPackage(projectId, 'Steel ER');
    await setRequiredSections(baseline(), [{ section: '03 30 00' }]);
    await setRequiredSections({ kind: 'package', projectId, packageId }, [{ section: '05 12 00' }]);
    expect((await listRequiredSections(baseline())).map((r) => r.section)).toEqual(['03 30 00']);
    expect(
      (await listRequiredSections({ kind: 'package', projectId, packageId })).map((r) => r.section)
    ).toEqual(['05 12 00']);
  });

  // KNOWN INVARIANT (ADR-015 D2): a package seeded from the baseline is a snapshot —
  // later baseline edits MUST NOT propagate into the package.
  it('seed: package copies the baseline as an independent snapshot', async () => {
    const packageId = await newPackage(projectId, 'CD set');
    const pkg: RequiredScope = { kind: 'package', projectId, packageId };
    await setRequiredSections(baseline(), [{ section: '03 30 00' }, { section: '09 91 00' }]);
    const seeded = await seedRequiredSections(pkg, { from: 'baseline' });
    expect(seeded.map((r) => r.section)).toEqual(['03 30 00', '09 91 00']);
    await setRequiredSections(baseline(), [{ section: '07 92 00' }]); // mutate baseline after seed
    expect((await listRequiredSections(pkg)).map((r) => r.section)).toEqual([
      '03 30 00',
      '09 91 00',
    ]);
  });

  it('seed: rejects a non-empty target scope with RequiredSectionsSeedConflictError', async () => {
    const packageId = await newPackage(projectId, 'dup');
    const pkg: RequiredScope = { kind: 'package', projectId, packageId };
    await setRequiredSections(pkg, [{ section: '05 12 00' }]);
    await expect(seedRequiredSections(pkg, { from: 'baseline' })).rejects.toBeInstanceOf(
      RequiredSectionsSeedConflictError
    );
  });

  it('rejects a duplicate section within a scope (partial unique index → 23505)', async () => {
    await expect(
      pool.query(
        `INSERT INTO required_sections (project_id, package_id, section, position)
         VALUES ($1, NULL, '03 30 00', 1), ($1, NULL, '03 30 00', 2)`,
        [projectId]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  // KNOWN INVARIANT (ADR-015 D2): a package seeded from another package is a snapshot —
  // later mutations to the source package MUST NOT propagate into the seeded target.
  it('seed: package copies another package as an independent snapshot', async () => {
    const sourcePkgId = await newPackage(projectId, 'source-pkg');
    const targetPkgId = await newPackage(projectId, 'target-pkg');
    const sourcePkg: RequiredScope = { kind: 'package', projectId, packageId: sourcePkgId };
    const targetPkg: RequiredScope = { kind: 'package', projectId, packageId: targetPkgId };

    const sourceEntries: readonly RequiredSectionInput[] = [
      { section: '03 30 00', title: 'Cast-in-Place Concrete' },
      { section: '05 12 00', title: 'Structural Steel Framing' },
    ];
    await setRequiredSections(sourcePkg, sourceEntries);

    const seeded = await seedRequiredSections(targetPkg, {
      from: 'package',
      packageId: sourcePkgId,
    });

    expect(seeded.map((r) => [r.section, r.position, r.title])).toEqual([
      ['03 30 00', 1, 'Cast-in-Place Concrete'],
      ['05 12 00', 2, 'Structural Steel Framing'],
    ]);

    // Mutate source; target must remain unchanged (snapshot independence)
    await setRequiredSections(sourcePkg, [{ section: '07 92 00', title: 'Joint Sealants' }]);
    const targetAfterMutation = await listRequiredSections(targetPkg);
    expect(targetAfterMutation.map((r) => r.section)).toEqual(['03 30 00', '05 12 00']);
  });
});
