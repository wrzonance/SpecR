import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';

// Pins the migration 053 scope-XOR invariant directly against the raw
// table — no query-layer module exists yet (that lands in a later task of
// this feature). Mirrors the migration-013 CHECK-constraint tests in
// specs.integration.test.ts: exercise the constraint through pool.query,
// assert on the constraint name in the rejection.

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
