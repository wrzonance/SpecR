import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';
import {
  upsertLanguageRuleProfile,
  findLanguageRuleProfile,
  deleteLanguageRuleProfile,
  resolveLanguageRulesForSpec,
  LanguageRuleValidationError,
  LanguageRuleScopeError,
} from './language-rule-profiles.js';

// Pins the migration 053 scope-XOR invariant directly against the raw
// table (task 2/8 of this feature). Mirrors the migration-013 CHECK-constraint
// tests in specs.integration.test.ts: exercise the constraint through
// pool.query, assert on the constraint name in the rejection. The query-layer
// module itself (CRUD + resolution, ADR-080 D3-D5) is pinned further down by
// the two describe blocks below (task 4/8).

describe('migration 053 — language_rule_profiles scope XOR', () => {
  let libraryId: string;
  let projectId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master'`
    );
    const libRow = lib.rows[0];
    if (!libRow) throw new Error('fixture library "Default Company Master" not seeded');
    libraryId = libRow.id;

    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Language Rule XOR Test Project') RETURNING id`
    );
    const projRow = proj.rows[0];
    if (!projRow) throw new Error('fixture project insert returned no row');
    projectId = projRow.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM language_rule_profiles WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM language_rule_profiles WHERE library_id = $1`, [libraryId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });

  it('db: accepts a library-scoped row (project_id NULL)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO language_rule_profiles (library_id, rules) VALUES ($1, '{}') RETURNING id`,
      [libraryId]
    );
    expect(r.rows).toHaveLength(1);
    await pool.query(`DELETE FROM language_rule_profiles WHERE id = $1`, [r.rows[0]?.id]);
  });

  it('db: accepts a project-scoped row (library_id NULL)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO language_rule_profiles (project_id, rules) VALUES ($1, '{}') RETURNING id`,
      [projectId]
    );
    expect(r.rows).toHaveLength(1);
    await pool.query(`DELETE FROM language_rule_profiles WHERE id = $1`, [r.rows[0]?.id]);
  });

  it('db: rejects a row with neither library_id nor project_id set', async () => {
    await expect(
      pool.query(`INSERT INTO language_rule_profiles (rules) VALUES ('{}')`)
    ).rejects.toThrow(/language_rule_profiles_owner_xor/);
  });

  it('db: rejects a row with both library_id and project_id set', async () => {
    await expect(
      pool.query(
        `INSERT INTO language_rule_profiles (library_id, project_id, rules) VALUES ($1, $2, '{}')`,
        [libraryId, projectId]
      )
    ).rejects.toThrow(/language_rule_profiles_owner_xor/);
  });

  it('db: rejects a second row for the same library (partial unique index)', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO language_rule_profiles (library_id, rules) VALUES ($1, '{}') RETURNING id`,
      [libraryId]
    );
    try {
      await expect(
        pool.query(`INSERT INTO language_rule_profiles (library_id, rules) VALUES ($1, '{}')`, [
          libraryId,
        ])
      ).rejects.toThrow(/language_rule_profiles_library_unique/);
    } finally {
      await pool.query(`DELETE FROM language_rule_profiles WHERE id = $1`, [r.rows[0]?.id]);
    }
  });

  it('db: rejects a non-object rules payload', async () => {
    await expect(
      pool.query(`INSERT INTO language_rule_profiles (library_id, rules) VALUES ($1, '[]')`, [
        libraryId,
      ])
    ).rejects.toThrow(/language_rule_profiles_rules_shape_check/);
  });
});

// Fixture registries for the two describe blocks below — every row created by
// a helper is tracked here and swept in one final afterAll, FK-safe order:
// specs first (specs.library_id/project_id/parent_spec_id have no ON DELETE
// action, i.e. RESTRICT), then projects, then clients, then libraries.
// language_rule_profiles rows are never deleted explicitly — migration 053
// CASCADEs both owner columns, so deleting the owning library/project sweeps
// them for free.
const fixtureSpecIds: string[] = [];
const fixtureProjectIds: string[] = [];
const fixtureClientIds: string[] = [];
const fixtureLibraryIds: string[] = [];

async function makeLibrary(tier: string, name: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ($1, $2) RETURNING id`,
    [tier, name]
  );
  const id = res.rows[0]!.id;
  fixtureLibraryIds.push(id);
  return id;
}

async function makeClient(name: string, libraryId: string | null): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO clients (name, library_id) VALUES ($1, $2) RETURNING id`,
    [name, libraryId]
  );
  const id = res.rows[0]!.id;
  fixtureClientIds.push(id);
  return id;
}

async function makeProject(name: string, clientId: string | null): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, client_id) VALUES ($1, $2) RETURNING id`,
    [name, clientId]
  );
  const id = res.rows[0]!.id;
  fixtureProjectIds.push(id);
  return id;
}

interface MakeSpecInput {
  readonly section: string;
  readonly title: string;
  readonly libraryId?: string;
  readonly projectId?: string;
  readonly parentSpecId?: string;
}

async function makeSpec(input: MakeSpecInput): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, project_id, parent_spec_id)
     VALUES ($1, $2, 'docx', $3, $4, $5) RETURNING id`,
    [
      input.section,
      input.title,
      input.libraryId ?? null,
      input.projectId ?? null,
      input.parentSpecId ?? null,
    ]
  );
  const id = res.rows[0]!.id;
  fixtureSpecIds.push(id);
  return id;
}

afterAll(async () => {
  if (fixtureSpecIds.length) {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [fixtureSpecIds]);
  }
  if (fixtureProjectIds.length) {
    await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [fixtureProjectIds]);
  }
  if (fixtureClientIds.length) {
    await pool.query(`DELETE FROM clients WHERE id = ANY($1::uuid[])`, [fixtureClientIds]);
  }
  if (fixtureLibraryIds.length) {
    await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [fixtureLibraryIds]);
  }
});

describe('language_rule_profiles query layer — CRUD (task 4/8)', () => {
  it('upsertLanguageRuleProfile -> findLanguageRuleProfile round-trips a library-scoped profile', async () => {
    const libraryId = await makeLibrary('client', 'Lang CRUD Library A (#411)');
    const created = await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'if required' }] }
    );
    expect(created).toMatchObject({ scope: 'library', ownerId: libraryId });
    expect(created.rules).toEqual({ bannedTerms: [{ term: 'if required' }] });

    const found = await findLanguageRuleProfile({ scope: 'library', ownerId: libraryId });
    expect(found?.id).toBe(created.id);
    expect(found?.rules).toEqual({ bannedTerms: [{ term: 'if required' }] });
  });

  it('upsertLanguageRuleProfile -> findLanguageRuleProfile round-trips a project-scoped profile', async () => {
    const projectId = await makeProject('Lang CRUD Project A (#411)', null);
    const created = await upsertLanguageRuleProfile(
      { scope: 'project', ownerId: projectId },
      { requiredPhrases: [{ term: 'furnish and install' }] }
    );
    expect(created).toMatchObject({ scope: 'project', ownerId: projectId });

    const found = await findLanguageRuleProfile({ scope: 'project', ownerId: projectId });
    expect(found?.rules).toEqual({ requiredPhrases: [{ term: 'furnish and install' }] });
  });

  it('a second upsert for the same scope updates in place (PUT semantics), same row id', async () => {
    const projectId = await makeProject('Lang CRUD Project B (#411)', null);
    const first = await upsertLanguageRuleProfile(
      { scope: 'project', ownerId: projectId },
      { bannedTerms: [{ term: 'as needed' }] }
    );
    const second = await upsertLanguageRuleProfile(
      { scope: 'project', ownerId: projectId },
      { bannedTerms: [{ term: 'may' }] }
    );
    expect(second.id).toBe(first.id);
    expect(second.rules).toEqual({ bannedTerms: [{ term: 'may' }] });
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it('deleteLanguageRuleProfile removes the row (true), then is a no-op (false)', async () => {
    const libraryId = await makeLibrary('client', 'Lang CRUD Library B (#411)');
    await upsertLanguageRuleProfile({ scope: 'library', ownerId: libraryId }, {});
    expect(await deleteLanguageRuleProfile({ scope: 'library', ownerId: libraryId })).toBe(true);
    expect(await findLanguageRuleProfile({ scope: 'library', ownerId: libraryId })).toBeNull();
    expect(await deleteLanguageRuleProfile({ scope: 'library', ownerId: libraryId })).toBe(false);
  });

  it('upsertLanguageRuleProfile rejects an unknown owner with LanguageRuleScopeError', async () => {
    await expect(
      upsertLanguageRuleProfile(
        { scope: 'library', ownerId: '00000000-0000-4000-8000-000000000000' },
        {}
      )
    ).rejects.toBeInstanceOf(LanguageRuleScopeError);
  });

  it('upsertLanguageRuleProfile rejects an unsafe regex, leaving no row behind', async () => {
    const libraryId = await makeLibrary('client', 'Lang CRUD Library C (#411)');
    await expect(
      upsertLanguageRuleProfile(
        { scope: 'library', ownerId: libraryId },
        { bannedTerms: [{ term: '(a+)+$', isRegex: true }] }
      )
    ).rejects.toBeInstanceOf(LanguageRuleValidationError);
    expect(await findLanguageRuleProfile({ scope: 'library', ownerId: libraryId })).toBeNull();
  });
});

describe('resolveLanguageRulesForSpec — resolution stack (ADR-080 D3-D5, task 4/8)', () => {
  it('a library master spec resolves through its own library_id directly', async () => {
    const libraryId = await makeLibrary('client', 'Lang Resolve Master Lib (#411)');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'if required' }] }
    );
    const specId = await makeSpec({ section: '09 91 26', title: 'Master', libraryId });

    const resolved = await resolveLanguageRulesForSpec(specId);
    expect(resolved.layers).toHaveLength(1);
    expect(resolved.layers[0]).toMatchObject({ scope: 'library', ownerId: libraryId });
    expect(resolved.rules).toEqual({ bannedTerms: [{ term: 'if required' }] });
  });

  it('a project-copy spec resolves the master library it was cloned from (D4), not just its own project', async () => {
    const libraryId = await makeLibrary('client', 'Lang Resolve Authoring Lib (#411)');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: libraryId },
      { bannedTerms: [{ term: 'if required' }] }
    );
    const masterId = await makeSpec({ section: '09 91 27', title: 'Master', libraryId });
    const projectId = await makeProject('Lang Resolve Project No Client (#411)', null);
    const copyId = await makeSpec({
      section: '09 91 27',
      title: 'Project Copy',
      projectId,
      parentSpecId: masterId,
    });

    const resolved = await resolveLanguageRulesForSpec(copyId);
    expect(resolved.layers).toHaveLength(1);
    expect(resolved.layers[0]).toMatchObject({ scope: 'library', ownerId: libraryId });
    expect(resolved.rules).toEqual({ bannedTerms: [{ term: 'if required' }] });
  });

  it('the client-library hop only fires when the project has a client WITH a library (D3)', async () => {
    const authoringLibId = await makeLibrary('client', 'Lang Resolve Hop Authoring (#411)');
    const clientLibId = await makeLibrary('client', 'Lang Resolve Hop Client Lib (#411)');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: authoringLibId },
      { bannedTerms: [{ term: 'shall', suggestion: 'authoring-suggestion' }] }
    );
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: clientLibId },
      { bannedTerms: [{ term: 'SHALL', suggestion: 'client-suggestion' }] }
    );
    const masterId = await makeSpec({
      section: '09 91 28',
      title: 'Master',
      libraryId: authoringLibId,
    });

    // Sibling project with a client that has NO library — the hop must not fire.
    const clientNoLib = await makeClient('Lang Resolve Client No Lib (#411)', null);
    const projNoLibId = await makeProject('Lang Resolve Project Client No Lib (#411)', clientNoLib);
    const copyNoLibId = await makeSpec({
      section: '09 91 28',
      title: 'Copy - client without library',
      projectId: projNoLibId,
      parentSpecId: masterId,
    });
    const resolvedNoLib = await resolveLanguageRulesForSpec(copyNoLibId);
    expect(resolvedNoLib.layers).toHaveLength(1);
    expect(resolvedNoLib.rules).toEqual({
      bannedTerms: [{ term: 'shall', suggestion: 'authoring-suggestion' }],
    });

    // Sibling project whose client DOES have a library — the hop fires, and
    // (D5) the narrower client layer wins the case-insensitive collision.
    const clientWithLib = await makeClient('Lang Resolve Client With Lib (#411)', clientLibId);
    const projWithLibId = await makeProject(
      'Lang Resolve Project Client With Lib (#411)',
      clientWithLib
    );
    const copyWithLibId = await makeSpec({
      section: '09 91 28',
      title: 'Copy - client with library',
      projectId: projWithLibId,
      parentSpecId: masterId,
    });
    const resolvedWithLib = await resolveLanguageRulesForSpec(copyWithLibId);
    expect(resolvedWithLib.layers.map((l) => l.ownerId)).toEqual([authoringLibId, clientLibId]);
    expect(resolvedWithLib.rules).toEqual({
      bannedTerms: [{ term: 'SHALL', suggestion: 'client-suggestion' }],
    });
  });

  it('all three layers merge broadest-to-narrowest, project profile winning last (D5)', async () => {
    const authoringLibId = await makeLibrary('client', 'Lang Resolve Full Authoring (#411)');
    const clientLibId = await makeLibrary('client', 'Lang Resolve Full Client Lib (#411)');
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: authoringLibId },
      { bannedTerms: [{ term: 'if required' }, { term: 'shall', suggestion: 'authoring' }] }
    );
    await upsertLanguageRuleProfile(
      { scope: 'library', ownerId: clientLibId },
      { bannedTerms: [{ term: 'shall', suggestion: 'client' }] }
    );
    const clientId = await makeClient('Lang Resolve Full Client (#411)', clientLibId);
    const projectId = await makeProject('Lang Resolve Full Project (#411)', clientId);
    await upsertLanguageRuleProfile(
      { scope: 'project', ownerId: projectId },
      { bannedTerms: [{ term: 'shall', suggestion: 'project' }] }
    );
    const masterId = await makeSpec({
      section: '09 91 29',
      title: 'Master',
      libraryId: authoringLibId,
    });
    const copyId = await makeSpec({
      section: '09 91 29',
      title: 'Project Copy',
      projectId,
      parentSpecId: masterId,
    });

    const resolved = await resolveLanguageRulesForSpec(copyId);
    expect(resolved.layers.map((l) => l.ownerId)).toEqual([authoringLibId, clientLibId, projectId]);
    expect(resolved.rules).toEqual({
      bannedTerms: [{ term: 'if required' }, { term: 'shall', suggestion: 'project' }],
    });
  });

  it('a reference-tier master with no lineage and no configured profile resolves cleanly empty', async () => {
    const referenceLibId = await makeLibrary('reference', 'Lang Resolve Reference Lib (#411)');
    const specId = await makeSpec({
      section: '09 91 30',
      title: 'Reference Master',
      libraryId: referenceLibId,
    });

    const resolved = await resolveLanguageRulesForSpec(specId);
    expect(resolved).toEqual({ layers: [], rules: {} });
  });

  it('an unknown specId resolves cleanly empty rather than throwing', async () => {
    const resolved = await resolveLanguageRulesForSpec('00000000-0000-4000-8000-000000000000');
    expect(resolved).toEqual({ layers: [], rules: {} });
  });
});
