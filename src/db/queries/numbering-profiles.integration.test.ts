import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createLibrary } from './libraries.js';
import { createSpec } from './specs.js';
import {
  listNumberingProfiles,
  getNumberingProfile,
  createNumberingProfile,
  updateNumberingProfile,
  deleteNumberingProfile,
  setSpecNumberingProfile,
  clearSpecNumberingProfile,
  getEffectiveNumberingProfile,
  NumberingProfileInUseError,
} from './numbering-profiles.js';
import type { NumberingProfile } from '../../ast/index.js';

// FK-safe cleanup order: clear spec FK refs → delete specs → delete custom profiles → delete libraries
afterEach(async () => {
  await pool.query(`UPDATE specs SET numbering_profile_id = NULL WHERE title LIKE 'np-test-%'`);
  await pool.query(`DELETE FROM specs WHERE title LIKE 'np-test-%'`);
  await pool.query(`DELETE FROM numbering_profiles WHERE library_id IS NOT NULL`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'np-test-%'`);
});

const MINIMAL_RULES: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

const ALT_RULES: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 3 } },
  numbering: [],
  styleLadder: [],
};

describe('migration 038 — CSI Default built-in seed', () => {
  it('db: built-in CSI Default is present and passes NumberingProfileSchema', async () => {
    const rows = await pool.query<{ name: string; rules: unknown }>(
      `SELECT name, rules FROM numbering_profiles WHERE library_id IS NULL ORDER BY created_at LIMIT 1`
    );
    expect(rows.rows[0]).toBeDefined();
    expect(rows.rows[0]?.name).toBe('CSI Default');
  });
});

describe('listNumberingProfiles', () => {
  it('(d) includes the built-in CSI Default even for a library with no custom profiles', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-list-no-profiles' });
    const profiles = await listNumberingProfiles(lib.id);
    const names = profiles.map((p) => p.name);
    expect(names).toContain('CSI Default');
  });

  it('includes both library profiles and the built-in default', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-list-both' });
    await createNumberingProfile(lib.id, 'Custom Profile', MINIMAL_RULES);
    const profiles = await listNumberingProfiles(lib.id);
    const names = profiles.map((p) => p.name);
    expect(names).toContain('CSI Default');
    expect(names).toContain('Custom Profile');
  });

  it('orders built-in last (library_id NULLS LAST)', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-list-order' });
    await createNumberingProfile(lib.id, 'First Custom', MINIMAL_RULES);
    const profiles = await listNumberingProfiles(lib.id);
    const lastProfile = profiles[profiles.length - 1];
    expect(lastProfile?.libraryId).toBeNull();
  });
});

describe('getNumberingProfile', () => {
  it('returns the profile by id', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-get' });
    const created = await createNumberingProfile(lib.id, 'Get Profile', MINIMAL_RULES);
    const found = await getNumberingProfile(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.name).toBe('Get Profile');
    expect(found?.libraryId).toBe(lib.id);
    expect(found?.rules).toEqual(MINIMAL_RULES);
  });

  it('returns null for an unknown id', async () => {
    const result = await getNumberingProfile('00000000-0000-4000-8000-000000000099');
    expect(result).toBeNull();
  });
});

describe('createNumberingProfile', () => {
  it('round-trips rules through NumberingProfileSchema', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-create' });
    const created = await createNumberingProfile(lib.id, 'Round-trip', MINIMAL_RULES);
    expect(created.libraryId).toBe(lib.id);
    expect(created.rules).toEqual(MINIMAL_RULES);
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });
});

describe('updateNumberingProfile', () => {
  it('updates name only (rules unchanged)', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-update-name' });
    const created = await createNumberingProfile(lib.id, 'Old Name', MINIMAL_RULES);
    const updated = await updateNumberingProfile(created.id, { name: 'New Name' });
    expect(updated?.name).toBe('New Name');
    expect(updated?.rules).toEqual(MINIMAL_RULES);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('updates rules only (name unchanged)', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-update-rules' });
    const created = await createNumberingProfile(lib.id, 'Stable Name', MINIMAL_RULES);
    const updated = await updateNumberingProfile(created.id, { rules: ALT_RULES });
    expect(updated?.name).toBe('Stable Name');
    expect(updated?.rules).toEqual(ALT_RULES);
  });

  it('returns null for an unknown id', async () => {
    const result = await updateNumberingProfile('00000000-0000-4000-8000-000000000099', {
      name: 'Ghost',
    });
    expect(result).toBeNull();
  });
});

describe('deleteNumberingProfile', () => {
  it('deletes an unreferenced profile and returns true', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-delete' });
    const created = await createNumberingProfile(lib.id, 'Delete Me', MINIMAL_RULES);
    const deleted = await deleteNumberingProfile(created.id);
    expect(deleted).toBe(true);
    expect(await getNumberingProfile(created.id)).toBeNull();
  });

  it('returns false for an unknown id', async () => {
    const deleted = await deleteNumberingProfile('00000000-0000-4000-8000-000000000099');
    expect(deleted).toBe(false);
  });

  it('(c) throws NumberingProfileInUseError when a spec references the profile (pg 23503)', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-delete-inuse' });
    const profile = await createNumberingProfile(lib.id, 'In Use Profile', MINIMAL_RULES);
    const specId = await createSpec({
      section: '07 21 16',
      title: 'np-test-in-use-spec',
      source: 'arcat',
      libraryId: lib.id,
    });
    await setSpecNumberingProfile(specId, profile.id);

    await expect(deleteNumberingProfile(profile.id)).rejects.toBeInstanceOf(
      NumberingProfileInUseError
    );
  });
});

describe('setSpecNumberingProfile / clearSpecNumberingProfile', () => {
  it('assigns a profile to a spec and clears it', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-assign' });
    const profile = await createNumberingProfile(lib.id, 'Assigned Profile', MINIMAL_RULES);
    const specId = await createSpec({
      section: '07 21 17',
      title: 'np-test-assign-spec',
      source: 'arcat',
      libraryId: lib.id,
    });

    const assigned = await setSpecNumberingProfile(specId, profile.id);
    expect(assigned).toBe(true);

    const cleared = await clearSpecNumberingProfile(specId);
    expect(cleared).toBe(true);
  });

  it('returns false for an unknown spec id', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-assign-miss' });
    const profile = await createNumberingProfile(lib.id, 'Orphan Assign', MINIMAL_RULES);
    const result = await setSpecNumberingProfile(
      '00000000-0000-4000-8000-000000000099',
      profile.id
    );
    expect(result).toBe(false);
  });
});

describe('getEffectiveNumberingProfile', () => {
  it('(a) returns the CSI Default when the spec has no assignment', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-eff-default' });
    const specId = await createSpec({
      section: '07 21 18',
      title: 'np-test-eff-default-spec',
      source: 'arcat',
      libraryId: lib.id,
    });

    const effective = await getEffectiveNumberingProfile(specId);
    // CSI Default has maxCount: 5
    expect(effective.tiers.part.maxCount).toBe(5);
  });

  it('(a) returns the CSI Default when the spec does not exist', async () => {
    const effective = await getEffectiveNumberingProfile('00000000-0000-4000-8000-000000000099');
    expect(effective.tiers.part.maxCount).toBe(5);
  });

  it('(b) returns the assigned profile rules after setSpecNumberingProfile', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-eff-assigned' });
    const profile = await createNumberingProfile(lib.id, 'Effective Profile', ALT_RULES);
    const specId = await createSpec({
      section: '07 21 19',
      title: 'np-test-eff-assigned-spec',
      source: 'arcat',
      libraryId: lib.id,
    });
    await setSpecNumberingProfile(specId, profile.id);

    const effective = await getEffectiveNumberingProfile(specId);
    expect(effective).toEqual(ALT_RULES);
  });

  it('(b) reverts to CSI Default after clearSpecNumberingProfile', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'np-test-eff-clear' });
    const profile = await createNumberingProfile(lib.id, 'Clear Profile', ALT_RULES);
    const specId = await createSpec({
      section: '07 21 20',
      title: 'np-test-eff-clear-spec',
      source: 'arcat',
      libraryId: lib.id,
    });
    await setSpecNumberingProfile(specId, profile.id);
    await clearSpecNumberingProfile(specId);

    const effective = await getEffectiveNumberingProfile(specId);
    expect(effective.tiers.part.maxCount).toBe(5);
  });
});
