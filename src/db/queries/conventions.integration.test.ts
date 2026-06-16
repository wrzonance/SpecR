import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { createLibrary, findLibraryByName, DEFAULT_COMPANY_LIBRARY } from './libraries.js';
import {
  insertConvention,
  updateConventionRules,
  findConventionById,
  getBuiltInConvention,
  getConventionForLibrary,
  BUILT_IN_CONVENTION_NAME,
  ConventionValidationError,
  ConventionNotFoundError,
} from './conventions.js';

// Reserved namespaces: every non-built-in convention (library_id NOT NULL) and
// test libraries named 'conv-test-*'. Cleanup order is FK-safe: conventions
// reference libraries, so conventions first.
afterEach(async () => {
  await pool.query(`DELETE FROM editing_conventions WHERE library_id IS NOT NULL`);
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'conv-test-%'`);
});

describe('migration 024 — built-in Industry Default seed', () => {
  it('db: built-in convention is present after migrate with the documented rules', async () => {
    const builtIn = await getBuiltInConvention();
    expect(builtIn).not.toBeNull();
    expect(builtIn).toMatchObject({ libraryId: null, name: BUILT_IN_CONVENTION_NAME });
    expect(builtIn?.rules).toEqual({
      colorMeanings: [{ color: '0000FF', meaning: 'editable' }],
      choiceTokens: [{ kind: 'angle' }, { kind: 'bracket' }],
      noteBanners: [
        '^NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\\b',
        '^SPEC(?:IFIER)?S? NOTES?\\b',
      ],
      comments: { treatAs: 'note' },
      defaultEditability: 'locked',
    });
  });

  it('db: seeded noteBanners reproduce the heuristics.ts detection behavior', () => {
    // Apply the seeded regexes the way the classifier (O-6) will: against the
    // undecorated, upper-cased banner text. They must still match the vendor
    // variants the hardcoded heuristics matched — no behavior change.
    const banners = [
      '^NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\\b',
      '^SPEC(?:IFIER)?S? NOTES?\\b',
    ].map((p) => new RegExp(p));
    const matches = (text: string): boolean => banners.some((re) => re.test(text));
    expect(matches('NOTE TO SPECIFIER')).toBe(true);
    expect(matches('NOTES TO THE SPEC WRITER')).toBe(true);
    expect(matches('SPECIFIER NOTES')).toBe(true);
    expect(matches('PART 1 GENERAL')).toBe(false);
  });
});

describe('editing_conventions — round-trip and library fallback', () => {
  it('insertConvention → findConventionById round-trips jsonb identically, unknown keys preserved', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-roundtrip' });
    const rules = {
      colorMeanings: [{ color: 'FF0000', meaning: 'note' as const, vendor: 'acme-red' }],
      defaultEditability: 'editable' as const,
      futureKnob: { weight: 7, labels: ['a', 'b'] },
    };
    const created = await insertConvention({ libraryId: lib.id, name: 'Acme Profile', rules });
    const found = await findConventionById(created.id);
    expect(found?.rules).toEqual(rules);
    expect(found?.libraryId).toBe(lib.id);
  });

  it('getConventionForLibrary falls back to the built-in when the library has no profile', async () => {
    const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY);
    const resolved = await getConventionForLibrary(company!.id);
    expect(resolved).toMatchObject({ libraryId: null, name: BUILT_IN_CONVENTION_NAME });
  });

  it("getConventionForLibrary returns the library's own profile when present", async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-own' });
    const created = await insertConvention({
      libraryId: lib.id,
      name: 'Own Profile',
      rules: { defaultEditability: 'editable' },
    });
    const resolved = await getConventionForLibrary(lib.id);
    expect(resolved?.id).toBe(created.id);
    expect(resolved?.libraryId).toBe(lib.id);
  });

  it('updateConventionRules replaces rules, bumps updated_at, and round-trips', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-update' });
    const created = await insertConvention({
      libraryId: lib.id,
      name: 'Mutable Profile',
      rules: { defaultEditability: 'locked' },
    });
    const updated = await updateConventionRules(created.id, {
      defaultEditability: 'editable',
      noteBanners: ['^SEE EDITOR\\b'],
    });
    expect(updated.rules).toEqual({
      defaultEditability: 'editable',
      noteBanners: ['^SEE EDITOR\\b'],
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('updateConventionRules throws ConventionNotFoundError for an unknown id', async () => {
    await expect(
      updateConventionRules('00000000-0000-4000-8000-000000000000', {
        defaultEditability: 'locked',
      })
    ).rejects.toBeInstanceOf(ConventionNotFoundError);
  });
});

describe('editing_conventions — regex write-boundary safety (ADR-022 D5)', () => {
  it('rejects an oversized noteBanners regex with ConventionValidationError', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-oversize' });
    await expect(
      insertConvention({
        libraryId: lib.id,
        name: 'Oversize',
        rules: { noteBanners: ['a'.repeat(500)] },
      })
    ).rejects.toBeInstanceOf(ConventionValidationError);
  });

  it('rejects a ReDoS-prone noteBanners regex with ConventionValidationError', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-redos' });
    await expect(
      insertConvention({
        libraryId: lib.id,
        name: 'Redos',
        rules: { noteBanners: ['(a+)+$'] },
      })
    ).rejects.toBeInstanceOf(ConventionValidationError);
  });

  it('rejects unsafe regex on update too, leaving the stored rules intact', async () => {
    const lib = await createLibrary({ tier: 'client', name: 'conv-test-update-unsafe' });
    const created = await insertConvention({
      libraryId: lib.id,
      name: 'Guarded',
      rules: { noteBanners: ['^OK\\b'] },
    });
    await expect(
      updateConventionRules(created.id, { noteBanners: ['(x*)*'] })
    ).rejects.toBeInstanceOf(ConventionValidationError);
    const found = await findConventionById(created.id);
    expect(found?.rules).toEqual({ noteBanners: ['^OK\\b'] });
  });
});
