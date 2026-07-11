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

// Reserved namespaces: every library-scoped rule (library_id NOT NULL) and test libraries
// named 'disc-test-*'. FK-safe order: rules reference libraries, so rules first.
afterEach(async () => {
  await pool.query(`DELETE FROM discipline_section_rules WHERE library_id IS NOT NULL`);
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

  it('db: an unknown discipline key rejects the whole write atomically', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'disc-test-atomic' });
    await expect(
      replaceLibraryDisciplineRules(lib.id, [
        { discipline: 'electrical', divisionStart: '26', divisionEnd: '26' },
        { discipline: 'not-a-discipline', divisionStart: '27', divisionEnd: '27' },
      ])
    ).rejects.toBeInstanceOf(DisciplineNotFoundError);
    // Rollback left no partial rows — the library still inherits the default.
    const rules = await resolveEffectiveRules(lib.id);
    expect(rules.some((r) => r.divisionStart === '26')).toBe(true); // built-in electrical
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
