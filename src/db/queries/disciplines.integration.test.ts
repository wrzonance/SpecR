import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createLibrary } from './libraries.js';
import {
  listDisciplines,
  resolveEffectiveRules,
  disciplineForSection,
  replaceLibraryDisciplineRules,
  clearLibraryDisciplineRules,
  DisciplineNotFoundError,
} from './disciplines.js';

// Scope teardown to this suite's own 'disc-test-*' libraries so it never deletes overrides
// owned by other integration files sharing this Postgres. FK-safe order: rules first.
afterEach(async () => {
  await pool.query(
    `DELETE FROM discipline_section_rules
      WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'disc-test-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'disc-test-%'`);
});

describe('migration 044 — built-in default discipline mapping', () => {
  it('db: catalog and default rules seed the CSI-division mapping', async () => {
    const resolved = await listDisciplines();
    expect(resolved.inherited).toBe(true);
    const byKey = new Map(resolved.disciplines.map((d) => [d.key, d]));
    expect(byKey.get('electrical')?.rules).toEqual([{ divisionStart: '26', divisionEnd: '26' }]);
    expect(byKey.get('hvac')?.rules).toEqual([{ divisionStart: '23', divisionEnd: '23' }]);
    expect(byKey.get('plumbing')?.rules).toEqual([{ divisionStart: '22', divisionEnd: '22' }]);
    // Mechanical is in the catalog but unmapped by the default rules (override target).
    expect(byKey.get('mechanical')?.rules).toEqual([]);
  });

  it('db: disciplineForSection resolves seeded divisions and leaves unmapped ones null', async () => {
    const rules = await resolveEffectiveRules(undefined);
    expect(disciplineForSection('26 05 19', rules)).toBe('electrical');
    expect(disciplineForSection('23 07 00', rules)).toBe('hvac');
    expect(disciplineForSection('28 23 00', rules)).toBe('electronic-safety-security');
    // Division 09 (finishes) is intentionally unmapped.
    expect(disciplineForSection('09 91 26', rules)).toBeNull();
  });
});

describe('per-library discipline override', () => {
  it('db: a library override wins for its own listing and leaves others on the default', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-override' });
    const other = await createLibrary({ tier: 'client', name: 'disc-test-untouched' });
    // Group all mechanical trades (21–23) under Mechanical.
    await replaceLibraryDisciplineRules(lib.id, [
      { discipline: 'mechanical', divisionStart: '21', divisionEnd: '23' },
    ]);

    const resolved = await listDisciplines(lib.id);
    expect(resolved.inherited).toBe(false);
    const overrideRules = await resolveEffectiveRules(lib.id);
    expect(disciplineForSection('23 07 00', overrideRules)).toBe('mechanical');
    expect(disciplineForSection('22 11 00', overrideRules)).toBe('mechanical');
    // The override is total — the built-in electrical rule is gone for this library.
    expect(disciplineForSection('26 05 19', overrideRules)).toBeNull();

    // A different library is unaffected — still the built-in default.
    const otherRules = await resolveEffectiveRules(other.id);
    expect(disciplineForSection('23 07 00', otherRules)).toBe('hvac');
    expect(disciplineForSection('26 05 19', otherRules)).toBe('electrical');
  });

  it('db: replacing a rule set overwrites the prior one wholesale', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-replace' });
    await replaceLibraryDisciplineRules(lib.id, [
      { discipline: 'electrical', divisionStart: '26', divisionEnd: '26' },
    ]);
    await replaceLibraryDisciplineRules(lib.id, [
      { discipline: 'plumbing', divisionStart: '22', divisionEnd: '22' },
    ]);
    const rules = await resolveEffectiveRules(lib.id);
    expect(rules).toEqual([{ disciplineKey: 'plumbing', divisionStart: '22', divisionEnd: '22' }]);
  });

  it('db: concurrent replacements for one library commit a single set, never a union', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-concurrent' });
    // Two racing PUTs with disjoint rule sets. Under READ COMMITTED without the library-row
    // lock, both DELETEs see an empty own-rule set and both INSERTs commit — the result unions
    // to two rows. The lock serializes them so exactly one complete set survives (last wins).
    await Promise.all([
      replaceLibraryDisciplineRules(lib.id, [
        { discipline: 'electrical', divisionStart: '26', divisionEnd: '26' },
      ]),
      replaceLibraryDisciplineRules(lib.id, [
        { discipline: 'plumbing', divisionStart: '22', divisionEnd: '22' },
      ]),
    ]);
    const rules = await resolveEffectiveRules(lib.id);
    expect(rules).toHaveLength(1);
    expect(['electrical', 'plumbing']).toContain(rules[0]?.disciplineKey);
  });

  it('db: an unknown discipline key rejects the whole write atomically', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-atomic' });
    await expect(
      replaceLibraryDisciplineRules(lib.id, [
        { discipline: 'electrical', divisionStart: '26', divisionEnd: '26' },
        { discipline: 'not-a-discipline', divisionStart: '27', divisionEnd: '27' },
      ])
    ).rejects.toBeInstanceOf(DisciplineNotFoundError);
    // Rollback left no partial rows — the library still inherits the default. Assert a
    // division ONLY the intact built-in maps (23→hvac): a partial write of just the first
    // (electrical) rule would suppress every built-in rule, so 23 would resolve to null.
    const rules = await resolveEffectiveRules(lib.id);
    expect(disciplineForSection('23 07 00', rules)).toBe('hvac');
  });

  it('db: clearing an override reverts the library to the built-in default', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-clear' });
    await replaceLibraryDisciplineRules(lib.id, [
      { discipline: 'mechanical', divisionStart: '21', divisionEnd: '23' },
    ]);
    expect(await clearLibraryDisciplineRules(lib.id)).toBe(true);
    const resolved = await listDisciplines(lib.id);
    expect(resolved.inherited).toBe(true);
    const rules = await resolveEffectiveRules(lib.id);
    expect(disciplineForSection('23 07 00', rules)).toBe('hvac');
    // Clearing again is a no-op.
    expect(await clearLibraryDisciplineRules(lib.id)).toBe(false);
  });
});
