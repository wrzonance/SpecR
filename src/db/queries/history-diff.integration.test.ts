import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSpecHistoryDiff, HistoryAnchorError, pool } from '../index.js';
import { createCheckpoint } from './checkpoints.js';

// ADR-052 D3/D9 (issue #380 task 6) — getSpecHistoryDiff's checkpoint:<uuid>
// anchor. Two fixtures: `spec` is the spec under test, sealed by its own
// checkpoint at content_version 1 with one pending edit past it; `otherSpec`
// is sealed by an unrelated checkpoint that never covered `spec`, so its
// content_version_map has no key for `spec`'s id — the exact shape needed to
// pin "checkpoint exists but doesn't cover this spec" as a DISTINCT error
// from "checkpoint id doesn't exist at all". Neither case may silently fall
// back to a default snapshot (e.g. content_version 1, or 'current').
const ids = {
  library: randomUUID(),
  spec: randomUUID(),
  paragraph: randomUUID(),
  otherSpec: randomUUID(),
  user: randomUUID(),
};

// content_version starts at 1 (pre-edit) so the checkpoint created below
// seals at version 1, not the post-edit version 2 — createCheckpoint reads
// specs.content_version live at INSERT time (checkpoints.ts), so the bump to
// 2 (and the corresponding second history row) must happen AFTER sealing.
async function seed(): Promise<void> {
  await pool.query(`INSERT INTO libraries (id, tier, name) VALUES ($1, 'company', $2)`, [
    ids.library,
    `history-diff-checkpoint-${ids.library}`,
  ]);
  await pool.query(`INSERT INTO users (id, label) VALUES ($1, $2)`, [
    ids.user,
    `history-diff-checkpoint-user-${ids.user}`,
  ]);
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id, content_version)
     VALUES ($1, '09 91 26', 'Checkpoint Anchor Fixture', 'docx', $2, 1)`,
    [ids.spec, ids.library]
  );
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id, content_version)
     VALUES ($1, '09 91 27', 'Unrelated Spec (never sealed by this spec)', 'docx', $2, 1)`,
    [ids.otherSpec, ids.library]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, node_type, text, position, base_version)
     VALUES ($1, $2, 'pr1', 'Sealed at version 1', 1, 1)`,
    [ids.paragraph, ids.spec]
  );
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, snapshot_at)
     VALUES ($1, $2, 1, 'Sealed at version 1', 'pr1', 'insert', 1, '2026-04-01T00:00:00Z')`,
    [ids.paragraph, ids.spec]
  );
}

async function editPastSeal(): Promise<void> {
  await pool.query(
    `UPDATE paragraphs SET text = 'Edited after seal', base_version = 2 WHERE id = $1`,
    [ids.paragraph]
  );
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, snapshot_at)
     VALUES ($1, $2, 2, 'Edited after seal', 'pr1', 'edit', 2, '2026-04-02T00:00:00Z')`,
    [ids.paragraph, ids.spec]
  );
  await pool.query(`UPDATE specs SET content_version = 2 WHERE id = $1`, [ids.spec]);
}

let sealingCheckpointId: string;
let unrelatedCheckpointId: string;

beforeAll(async () => {
  await seed();
  const sealing = await createCheckpoint(
    { name: `Sealed ${ids.spec}`, scope: 'spec', scopeId: ids.spec, userId: ids.user },
    pool
  );
  sealingCheckpointId = sealing.id;
  const unrelated = await createCheckpoint(
    { name: `Sealed ${ids.otherSpec}`, scope: 'spec', scopeId: ids.otherSpec, userId: ids.user },
    pool
  );
  unrelatedCheckpointId = unrelated.id;
  await editPastSeal();
});

afterAll(async () => {
  // Cascades paragraphs/paragraph_versions/checkpoints for both specs (each
  // FKs to specs ON DELETE CASCADE).
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[ids.spec, ids.otherSpec]]);
  await pool.query('DELETE FROM users WHERE id = $1', [ids.user]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [ids.library]);
});

describe('getSpecHistoryDiff — checkpoint:<uuid> anchor (issue #380 task 6)', () => {
  it('throws HistoryAnchorError when the checkpoint id does not exist', async () => {
    const missingCheckpointId = randomUUID();

    await expect(
      getSpecHistoryDiff(ids.spec, `checkpoint:${missingCheckpointId}`, 'current', pool)
    ).rejects.toThrow(HistoryAnchorError);
  });

  it('throws a distinct HistoryAnchorError when the checkpoint exists but never sealed this spec', async () => {
    const missingCheckpointId = randomUUID();

    let missingCheckpointError: unknown;
    try {
      await getSpecHistoryDiff(ids.spec, `checkpoint:${missingCheckpointId}`, 'current', pool);
    } catch (err) {
      missingCheckpointError = err;
    }

    let uncoveredSpecError: unknown;
    try {
      // unrelatedCheckpointId is a real checkpoint row, but it sealed
      // otherSpec — its content_version_map has no key for `ids.spec`.
      await getSpecHistoryDiff(ids.spec, `checkpoint:${unrelatedCheckpointId}`, 'current', pool);
    } catch (err) {
      uncoveredSpecError = err;
    }

    expect(missingCheckpointError).toBeInstanceOf(HistoryAnchorError);
    expect(uncoveredSpecError).toBeInstanceOf(HistoryAnchorError);
    expect((uncoveredSpecError as Error).message).not.toBe(
      (missingCheckpointError as Error).message
    );
  });

  it('resolves a checkpoint anchor to the exact content_version it sealed, never current', async () => {
    const diff = await getSpecHistoryDiff(
      ids.spec,
      `checkpoint:${sealingCheckpointId}`,
      'current',
      pool
    );

    expect(diff?.modified).toEqual([
      expect.objectContaining({
        nodeId: ids.paragraph,
        beforeText: 'Sealed at version 1',
        afterText: 'Edited after seal',
      }),
    ]);
  });
});
