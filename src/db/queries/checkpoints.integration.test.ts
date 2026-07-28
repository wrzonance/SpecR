import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../index.js';

// ADR-052 D3/D4 (issue #380 task 3) — migration 052's checkpoints table plus
// the query layer over it (./checkpoints.ts): createCheckpoint,
// listCheckpoints, getCheckpointById, getCheckpointBoundariesForSpec,
// getLatestCheckpointBoundary. The scope-XOR describe block below pins the
// schema-level invariant directly against Postgres (mirroring
// revit.integration.test.ts's "CHECK constraints (enforced by Postgres,
// asserted via raw SQL)" pattern); the second describe block exercises the
// same invariant plus the D3-amendment sealing/immutability rules through the
// query layer itself, against real jsonb data.
//
// Namespace reserved by this file: rows created under a dedicated spec/project/
// user labeled 'checkpoints-test-<suffix>' and cleaned up in afterAll.
const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `checkpoints-test-${suffix}-${name}`;

let specId: string;
let projectId: string;
let userId: string;

// Query-layer fixtures — a standalone library-scoped spec, and a project with
// one spec already in it (a second spec is inserted mid-test to prove a
// project checkpoint's snapshot never grows after the fact).
const qlLoneSpecId = randomUUID();
const qlProjectId = randomUUID();
const qlSpecAId = randomUUID();
const qlSpecBId = randomUUID();
const qlEmptyProjectId = randomUUID();

async function insertLibrarySpec(id: string, section: string, title: string): Promise<void> {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, $2, $3, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))`,
    [id, section, title]
  );
}

async function insertProjectSpec(
  id: string,
  projectOwnerId: string,
  section: string
): Promise<void> {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, project_id) VALUES ($1, $2, $3, 'arcat', $4)`,
    [id, section, label(`project-spec-${section}`), projectOwnerId]
  );
}

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

  await insertLibrarySpec(qlLoneSpecId, '27 12 00', label('ql-lone-spec'));
  await pool.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
    qlProjectId,
    label('ql-project'),
  ]);
  await pool.query('INSERT INTO projects (id, name) VALUES ($1, $2)', [
    qlEmptyProjectId,
    label('ql-empty-project'),
  ]);
  await insertProjectSpec(qlSpecAId, qlProjectId, '27 21 00');
  // qlSpecBId is deliberately NOT inserted here — the "added after checkpoint"
  // test inserts it mid-test, once an early project checkpoint already exists.
});

afterAll(async () => {
  await pool.query('DELETE FROM checkpoints WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [
    [specId, qlLoneSpecId, qlSpecAId, qlSpecBId],
  ]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [
    [projectId, qlProjectId, qlEmptyProjectId],
  ]);
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

describe('checkpoints query layer (issue #380 task 3)', () => {
  it('createCheckpoint (spec scope): snapshots content_version, then is immune to later edits', async () => {
    const { createCheckpoint, getCheckpointById } = await import('./checkpoints.js');
    await pool.query('UPDATE specs SET content_version = 4 WHERE id = $1', [qlLoneSpecId]);

    const checkpoint = await createCheckpoint(
      { name: label('spec-seal'), scope: 'spec', scopeId: qlLoneSpecId, userId },
      pool
    );
    expect(checkpoint.scope).toBe('spec');
    expect(checkpoint.scopeId).toBe(qlLoneSpecId);
    expect(checkpoint.contentVersionMap).toEqual({ [qlLoneSpecId]: 4 });

    // D2 never-squash extended to tier 1: a later content write to the spec
    // must never retroactively change a sealed checkpoint's recorded map.
    await pool.query('UPDATE specs SET content_version = 9 WHERE id = $1', [qlLoneSpecId]);
    const reread = await getCheckpointById(checkpoint.id, pool);
    expect(reread?.contentVersionMap).toEqual({ [qlLoneSpecId]: 4 });
  });

  it('createCheckpoint (project scope): aggregates every in-scope spec; a spec added later never appears in the sealed map; an empty project seals as {}', async () => {
    const { createCheckpoint, getCheckpointById } = await import('./checkpoints.js');
    await pool.query('UPDATE specs SET content_version = 2 WHERE id = $1', [qlSpecAId]);

    const early = await createCheckpoint(
      { name: label('project-early'), scope: 'project', scopeId: qlProjectId, userId },
      pool
    );
    expect(early.scope).toBe('project');
    expect(early.contentVersionMap).toEqual({ [qlSpecAId]: 2 });

    await insertProjectSpec(qlSpecBId, qlProjectId, '27 22 00');
    const rereadEarly = await getCheckpointById(early.id, pool);
    expect(rereadEarly?.contentVersionMap).toEqual({ [qlSpecAId]: 2 });

    const empty = await createCheckpoint(
      { name: label('empty-project'), scope: 'project', scopeId: qlEmptyProjectId, userId },
      pool
    );
    expect(empty.contentVersionMap).toEqual({});
  });

  it('createCheckpoint rejects an unknown scopeId with CheckpointScopeNotFoundError', async () => {
    const { createCheckpoint, CheckpointScopeNotFoundError } = await import('./checkpoints.js');

    await expect(
      createCheckpoint(
        { name: label('missing'), scope: 'spec', scopeId: randomUUID(), userId },
        pool
      )
    ).rejects.toBeInstanceOf(CheckpointScopeNotFoundError);
    await expect(
      createCheckpoint(
        { name: label('missing'), scope: 'project', scopeId: randomUUID(), userId },
        pool
      )
    ).rejects.toBeInstanceOf(CheckpointScopeNotFoundError);
  });

  it('listCheckpoints and getCheckpointById round-trip a created checkpoint', async () => {
    const { createCheckpoint, listCheckpoints, getCheckpointById } =
      await import('./checkpoints.js');
    const created = await createCheckpoint(
      { name: label('list-me'), scope: 'spec', scopeId: qlLoneSpecId, userId },
      pool
    );

    const list = await listCheckpoints('spec', qlLoneSpecId, pool);
    expect(list.some((c) => c.id === created.id)).toBe(true);
    expect(await listCheckpoints('project', qlLoneSpecId, pool)).toEqual([]);

    expect(await getCheckpointById(created.id, pool)).toEqual(created);
    expect(await getCheckpointById(randomUUID(), pool)).toBeNull();
  });

  it('getCheckpointBoundariesForSpec / getLatestCheckpointBoundary resolve spec- and project-scoped checkpoints alike, ascending by contentVersion', async () => {
    const { createCheckpoint, getCheckpointBoundariesForSpec, getLatestCheckpointBoundary } =
      await import('./checkpoints.js');

    await pool.query('UPDATE specs SET content_version = 3 WHERE id = $1', [qlSpecAId]);
    const specCheckpoint = await createCheckpoint(
      { name: label('boundary-spec'), scope: 'spec', scopeId: qlSpecAId, userId },
      pool
    );
    await pool.query('UPDATE specs SET content_version = 8 WHERE id = $1', [qlSpecAId]);
    const projectCheckpoint = await createCheckpoint(
      { name: label('boundary-project'), scope: 'project', scopeId: qlProjectId, userId },
      pool
    );

    const boundaries = await getCheckpointBoundariesForSpec(qlSpecAId, pool);
    const relevant = boundaries.filter((b) =>
      [specCheckpoint.id, projectCheckpoint.id].includes(b.checkpointId)
    );
    expect(relevant.map((b) => b.checkpointId)).toEqual([specCheckpoint.id, projectCheckpoint.id]);
    expect(relevant.map((b) => b.contentVersion)).toEqual([3, 8]);

    const latest = await getLatestCheckpointBoundary(qlSpecAId, pool);
    expect(latest).toEqual(boundaries.at(-1));

    // A spec no checkpoint has ever sealed has neither a boundary list nor a latest.
    const untouchedSpecId = randomUUID();
    expect(await getCheckpointBoundariesForSpec(untouchedSpecId, pool)).toEqual([]);
    expect(await getLatestCheckpointBoundary(untouchedSpecId, pool)).toBeNull();
  });

  it('content_version_map key is case-folded to canonical form, so a checkpoint stays visible to boundary lookups regardless of scopeId/specId letter-casing (regression, #380 review finding)', async () => {
    const { createCheckpoint, getCheckpointBoundariesForSpec, getLatestCheckpointBoundary } =
      await import('./checkpoints.js');
    await pool.query('UPDATE specs SET content_version = 5 WHERE id = $1', [qlLoneSpecId]);
    const uppercasedScopeId = qlLoneSpecId.toUpperCase();

    const checkpoint = await createCheckpoint(
      { name: label('case-fold'), scope: 'spec', scopeId: uppercasedScopeId, userId },
      pool
    );

    // The stored map key is always the canonical (lowercase) spec id, never
    // the caller's original casing.
    expect(Object.keys(checkpoint.contentVersionMap)).toEqual([qlLoneSpecId]);
    expect(checkpoint.contentVersionMap).toEqual({ [qlLoneSpecId]: 5 });

    // A later boundary lookup by the canonical id resolves it...
    const canonicalBoundaries = await getCheckpointBoundariesForSpec(qlLoneSpecId, pool);
    expect(canonicalBoundaries.some((b) => b.checkpointId === checkpoint.id)).toBe(true);

    // ...and so does a lookup using a DIFFERENT casing of that same id.
    const uppercaseBoundaries = await getCheckpointBoundariesForSpec(uppercasedScopeId, pool);
    expect(uppercaseBoundaries.some((b) => b.checkpointId === checkpoint.id)).toBe(true);

    // getLatestCheckpointBoundary must agree regardless of which casing of
    // the spec id is used to ask — it's a pure lookup-key difference, never a
    // different answer.
    const latestCanonical = await getLatestCheckpointBoundary(qlLoneSpecId, pool);
    const latestUppercase = await getLatestCheckpointBoundary(uppercasedScopeId, pool);
    expect(latestUppercase).toEqual(latestCanonical);
  });
});
