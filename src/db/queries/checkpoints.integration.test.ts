import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';

// ADR-052 D3/D4 — migration 052's checkpoints table. No query module exists yet
// (that lands with the coalescer/read-surface tasks later in issue #380); this
// file pins the schema-level invariant directly against Postgres, mirroring
// revit.integration.test.ts's "CHECK constraints (enforced by Postgres,
// asserted via raw SQL)" pattern.
//
// Namespace reserved by this file: rows created under a dedicated spec/project/
// user labeled 'checkpoints-test-<suffix>' and cleaned up in afterAll.
const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `checkpoints-test-${suffix}-${name}`;

let specId: string;
let projectId: string;
let userId: string;

beforeAll(async () => {
  const specRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 11 00', $1, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [label('spec')]
  );
  const spec = specRow.rows[0];
  if (spec === undefined) throw new Error('checkpoints fixture: failed to create spec');
  specId = spec.id;

  const projectRow = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [label('project')]
  );
  const project = projectRow.rows[0];
  if (project === undefined) throw new Error('checkpoints fixture: failed to create project');
  projectId = project.id;

  const userRow = await pool.query<{ id: string }>(
    `INSERT INTO users (label) VALUES ($1) RETURNING id`,
    [label('user')]
  );
  const user = userRow.rows[0];
  if (user === undefined) throw new Error('checkpoints fixture: failed to create user');
  userId = user.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM checkpoints WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
});

describe('migration 052 — checkpoints scope XOR (enforced by Postgres, asserted via raw SQL)', () => {
  it('accepts a spec-scoped checkpoint (spec_id set, project_id NULL)', async () => {
    const { rows } = await pool.query<{ id: string; spec_id: string; project_id: string | null }>(
      `INSERT INTO checkpoints (name, spec_id, user_id)
       VALUES ($1, $2, $3)
       RETURNING id, spec_id, project_id`,
      [label('spec-scoped'), specId, userId]
    );
    expect(rows[0]).toMatchObject({ spec_id: specId, project_id: null });
  });

  it('accepts a project-scoped checkpoint (project_id set, spec_id NULL)', async () => {
    const { rows } = await pool.query<{
      id: string;
      spec_id: string | null;
      project_id: string;
    }>(
      `INSERT INTO checkpoints (name, project_id, user_id)
       VALUES ($1, $2, $3)
       RETURNING id, spec_id, project_id`,
      [label('project-scoped'), projectId, userId]
    );
    expect(rows[0]).toMatchObject({ spec_id: null, project_id: projectId });
  });

  it('rejects a checkpoint with neither spec_id nor project_id set', async () => {
    await expect(
      pool.query(`INSERT INTO checkpoints (name, user_id) VALUES ($1, $2)`, [
        label('neither-scope'),
        userId,
      ])
    ).rejects.toThrow(/checkpoints_scope_xor/);
  });

  it('rejects a checkpoint with both spec_id and project_id set', async () => {
    await expect(
      pool.query(
        `INSERT INTO checkpoints (name, spec_id, project_id, user_id) VALUES ($1, $2, $3, $4)`,
        [label('both-scope'), specId, projectId, userId]
      )
    ).rejects.toThrow(/checkpoints_scope_xor/);
  });
});
