import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getParagraphHistory,
  getCoalescedParagraphHistory,
  getSpecHistory,
  getSpecHistoryDiff,
  pool,
} from '../index.js';
import { createCheckpoint } from './checkpoints.js';

const SESSION_WINDOW_MS = 30 * 60 * 1000;

const ids = {
  library: randomUUID(),
  project: randomUUID(),
  masterSpec: randomUUID(),
  projectSpec: randomUUID(),
  masterParagraph: randomUUID(),
  editedParagraph: randomUUID(),
  insertedParagraph: randomUUID(),
  removedParagraph: randomUUID(),
  package: randomUUID(),
  revision: randomUUID(),
  // Task 5 (actor attribution / checkpoint milestones / coalesced sessions) —
  // a standalone spec+paragraph so checkpoint sealing doesn't interact with
  // the revision-tree fixture above.
  actorSpec: randomUUID(),
  actorParagraph: randomUUID(),
  alice: randomUUID(),
  bob: randomUUID(),
};

const revisionTree = {
  id: ids.projectSpec,
  section: '09 91 26',
  title: 'Cementitious Coatings',
  parts: [
    {
      id: ids.editedParagraph,
      type: 'pr1',
      text: 'Edited once',
      children: [],
      meta: {},
    },
    {
      id: ids.removedParagraph,
      type: 'pr1',
      text: 'Removed later',
      children: [],
      meta: {},
    },
  ],
};

async function seedSpecs(): Promise<void> {
  await pool.query(`INSERT INTO libraries (id, tier, name) VALUES ($1, 'company', $2)`, [
    ids.library,
    `history-${ids.library}`,
  ]);
  await pool.query(`INSERT INTO projects (id, name) VALUES ($1, $2)`, [
    ids.project,
    `history-${ids.project}`,
  ]);
  await pool.query(
    `INSERT INTO specs
       (id, section, title, source, library_id, content_version, created_at, updated_at)
     VALUES ($1, '09 91 26', 'Master', 'docx', $2, 2, $3, $4)`,
    [ids.masterSpec, ids.library, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z']
  );
  await pool.query(
    `INSERT INTO specs
       (id, section, title, source, project_id, parent_spec_id, origin_version,
        content_version, created_at, updated_at)
     VALUES ($1, '09 91 26', 'Cementitious Coatings', 'docx', $2, $3, 2, 4, $4, $5)`,
    [ids.projectSpec, ids.project, ids.masterSpec, '2026-02-01T00:00:00Z', '2026-02-04T00:00:00Z']
  );
}

async function seedParagraphs(): Promise<void> {
  await pool.query(
    `INSERT INTO paragraphs
       (id, spec_id, node_type, text, position, base_version, created_at, updated_at)
     VALUES
       ($1, $2, 'pr1', 'Master revised', 1, 2, $3, $4),
       ($5, $6, 'pr1', 'Edited twice', 1, 4, $7, $8),
       ($9, $6, 'pr1', 'Added later', 2, 1, $10, $10),
       ($11, $6, 'pr1', 'Removed later', 3, 2, $7, $8)`,
    [
      ids.masterParagraph,
      ids.masterSpec,
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      ids.editedParagraph,
      ids.projectSpec,
      '2026-02-01T00:00:00Z',
      '2026-02-04T00:00:00Z',
      ids.insertedParagraph,
      '2026-02-03T00:00:00Z',
      ids.removedParagraph,
    ]
  );
  await pool.query(`UPDATE paragraphs SET origin_paragraph_id = $1 WHERE id = $2`, [
    ids.masterParagraph,
    ids.editedParagraph,
  ]);
  await pool.query(`UPDATE paragraphs SET vanish = true WHERE id = $1`, [ids.removedParagraph]);
}

async function seedHistory(): Promise<void> {
  // Version 2 is deliberately backdated: transaction-start timestamps can invert
  // after a row-lock wait, but the paragraph's monotonic version defines history order.
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, snapshot_at, payload)
     VALUES
       ($1, $2, 1, 'Master original', 'pr1', 'insert', 1, '2026-01-01T00:00:00Z', NULL),
       ($1, $2, 2, 'Master revised', 'pr1', 'edit', 2, '2025-12-31T00:00:00Z', NULL),
       ($3, $4, 3, 'Edited once', 'pr1', 'edit', 2, '2026-02-02T00:00:00Z', NULL),
       ($5, $4, 1, 'Added later', 'pr1', 'merge', 3, '2026-02-03T00:00:00Z',
        '{"diffKind":"added"}'::jsonb),
       ($3, $4, 4, 'Edited twice', 'pr1', 'edit', 4, '2026-02-04T00:00:00Z', NULL),
       ($6, $4, 2, 'Removed later', 'pr1', 'remove', 4, '2026-02-04T00:00:00Z', NULL)`,
    [
      ids.masterParagraph,
      ids.masterSpec,
      ids.editedParagraph,
      ids.projectSpec,
      ids.insertedParagraph,
      ids.removedParagraph,
    ]
  );
}

let actorCheckpointId: string;

/** A standalone spec+paragraph (task 5): one edit by alice, sealed by a
 *  checkpoint at content_version 1, then one pending edit by bob at
 *  content_version 2 — exercises actor attribution, checkpoint milestones,
 *  and coalesced-session sealing together against real rows. */
async function seedActorFixture(): Promise<void> {
  await pool.query(`INSERT INTO users (id, label) VALUES ($1, $2), ($3, $4)`, [
    ids.alice,
    `history-actor-alice-${ids.alice}`,
    ids.bob,
    `history-actor-bob-${ids.bob}`,
  ]);
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id, content_version)
     VALUES ($1, '09 91 30', 'Actor Fixture', 'docx', $2, 1)`,
    [ids.actorSpec, ids.library]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, node_type, text, position, base_version)
     VALUES ($1, $2, 'pr1', 'Created by alice', 1, 1)`,
    [ids.actorParagraph, ids.actorSpec]
  );
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, user_id, snapshot_at)
     VALUES ($1, $2, 1, 'Created by alice', 'pr1', 'insert', 1, $3, '2026-03-01T00:00:00Z')`,
    [ids.actorParagraph, ids.actorSpec, ids.alice]
  );
  const checkpoint = await createCheckpoint(
    {
      name: `Reviewed by alice ${ids.actorSpec}`,
      scope: 'spec',
      scopeId: ids.actorSpec,
      userId: ids.alice,
    },
    pool
  );
  actorCheckpointId = checkpoint.id;
  await pool.query(`UPDATE paragraphs SET base_version = 2, text = 'Edited by bob' WHERE id = $1`, [
    ids.actorParagraph,
  ]);
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, user_id, snapshot_at)
     VALUES ($1, $2, 2, 'Edited by bob', 'pr1', 'edit', 2, $3, '2026-03-02T00:00:00Z')`,
    [ids.actorParagraph, ids.actorSpec, ids.bob]
  );
  await pool.query(`UPDATE specs SET content_version = 2 WHERE id = $1`, [ids.actorSpec]);
}

async function seedRevision(): Promise<void> {
  await pool.query(
    `INSERT INTO design_packages (id, project_id, name, position)
     VALUES ($1, $2, 'History Package', 1)`,
    [ids.package, ids.project]
  );
  await pool.query(
    `INSERT INTO package_revisions
       (id, package_id, label, revision_type, revision_date, sort_order, attributes, issued_at)
     VALUES ($1, $2, '50% CD', 'milestone', '2026-02-02', 1, '{}'::jsonb, $3)`,
    [ids.revision, ids.package, '2026-02-02T12:00:00Z']
  );
  await pool.query(
    `INSERT INTO package_revision_specs (revision_id, spec_id, position, tree)
     VALUES ($1, $2, 1, $3::jsonb)`,
    [ids.revision, ids.projectSpec, JSON.stringify(revisionTree)]
  );
}

beforeAll(async () => {
  await seedSpecs();
  await seedParagraphs();
  await seedHistory();
  await seedRevision();
  await seedActorFixture();
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE id = $1', [ids.package]);
  await pool.query('DELETE FROM specs WHERE id = $1', [ids.projectSpec]);
  await pool.query('DELETE FROM projects WHERE id = $1', [ids.project]);
  await pool.query('DELETE FROM specs WHERE id = $1', [ids.masterSpec]);
  // Cascades paragraphs/paragraph_versions/checkpoints for this spec (each
  // FKs to specs ON DELETE CASCADE).
  await pool.query('DELETE FROM specs WHERE id = $1', [ids.actorSpec]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[ids.alice, ids.bob]]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [ids.library]);
});

describe('version-history read model (#378)', () => {
  it('paragraph history is oldest-first and includeOrigin crosses the derive hop', async () => {
    const local = await getParagraphHistory(ids.projectSpec, ids.editedParagraph, false, pool);
    expect(local?.map((entry) => entry.text)).toEqual([
      'Master revised',
      'Edited once',
      'Edited twice',
    ]);
    expect(local?.every((entry) => entry.custody === 'spec')).toBe(true);

    const withOrigin = await getParagraphHistory(ids.projectSpec, ids.editedParagraph, true, pool);
    expect(withOrigin?.map((entry) => entry.text)).toEqual([
      'Master original',
      'Master revised',
      'Master revised',
      'Edited once',
      'Edited twice',
    ]);
    expect(withOrigin?.slice(0, 2).every((entry) => entry.custody === 'origin')).toBe(true);
  });

  it('document timeline groups paragraph operations and decorates revision milestones', async () => {
    const timeline = await getSpecHistory(ids.projectSpec, ids.package, pool);
    expect(timeline?.steps).toEqual([
      expect.objectContaining({ contentVersion: 1, ops: { edited: 0, inserted: 0, removed: 0 } }),
      expect.objectContaining({ contentVersion: 2, ops: { edited: 1, inserted: 0, removed: 0 } }),
      expect.objectContaining({ contentVersion: 3, ops: { edited: 0, inserted: 1, removed: 0 } }),
      expect.objectContaining({ contentVersion: 4, ops: { edited: 1, inserted: 0, removed: 1 } }),
    ]);
    expect(timeline?.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'origin', parentSpecId: ids.masterSpec, originVersion: 2 }),
        expect.objectContaining({ kind: 'revision', revisionId: ids.revision }),
      ])
    );
  });

  it('point-to-point diff aligns rows and returns added/removed/modified in document order', async () => {
    const deriveDiff = await getSpecHistoryDiff(ids.projectSpec, 'origin', 1, pool);
    expect(deriveDiff?.modified).toEqual([]);
    expect(deriveDiff?.added.map((row) => row.nodeId)).toEqual([ids.removedParagraph]);

    const diff = await getSpecHistoryDiff(ids.projectSpec, 2, 'current', pool);
    expect(diff?.added).toEqual([
      expect.objectContaining({ nodeId: ids.insertedParagraph, afterText: 'Added later' }),
    ]);
    expect(diff?.removed).toEqual([
      expect.objectContaining({ nodeId: ids.removedParagraph, beforeText: 'Removed later' }),
    ]);
    expect(diff?.modified).toEqual([
      expect.objectContaining({
        nodeId: ids.editedParagraph,
        beforeText: 'Edited once',
        afterText: 'Edited twice',
      }),
    ]);
  });

  it('revision UUIDs are first-class diff anchors', async () => {
    const diff = await getSpecHistoryDiff(ids.projectSpec, ids.revision, 'current', pool);
    expect(diff?.added.map((row) => row.nodeId)).toEqual([ids.insertedParagraph]);
    expect(diff?.removed.map((row) => row.nodeId)).toEqual([ids.removedParagraph]);
    expect(diff?.modified.map((row) => row.nodeId)).toEqual([ids.editedParagraph]);
  });
});

describe('actor attribution, checkpoint milestones, coalesced sessions (issue #380 task 5)', () => {
  it('getParagraphHistory attaches real userId/actorLabel per row', async () => {
    const entries = await getParagraphHistory(ids.actorSpec, ids.actorParagraph, false, pool);

    expect(entries).toEqual([
      expect.objectContaining({
        version: 1,
        userId: ids.alice,
        actorLabel: `history-actor-alice-${ids.alice}`,
      }),
      expect.objectContaining({
        version: 2,
        userId: ids.bob,
        actorLabel: `history-actor-bob-${ids.bob}`,
      }),
    ]);
  });

  it('getCoalescedParagraphHistory and getParagraphHistory agree null for the same not-found paragraph', async () => {
    const missing = randomUUID();

    const raw = await getParagraphHistory(ids.actorSpec, missing, false, pool);
    const coalesced = await getCoalescedParagraphHistory(
      ids.actorSpec,
      missing,
      SESSION_WINDOW_MS,
      false,
      pool
    );

    expect(raw).toBeNull();
    expect(coalesced).toBeNull();
  });

  it('getCoalescedParagraphHistory splits on the actor change and seals the alice session at the real checkpoint', async () => {
    const sessions = await getCoalescedParagraphHistory(
      ids.actorSpec,
      ids.actorParagraph,
      SESSION_WINDOW_MS,
      false,
      pool
    );

    expect(sessions).toHaveLength(2);
    expect(sessions?.[0]).toEqual(
      expect.objectContaining({
        userId: ids.alice,
        sealedContentVersion: 1,
        sealedByCheckpointId: actorCheckpointId,
      })
    );
    expect(sessions?.[1]).toEqual(
      expect.objectContaining({
        userId: ids.bob,
        sealedContentVersion: 2,
        sealedByCheckpointId: null,
      })
    );
  });

  it('getSpecHistory surfaces the checkpoint as a milestone alongside origin', async () => {
    const timeline = await getSpecHistory(ids.actorSpec, undefined, pool);

    expect(timeline?.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'origin' }),
        expect.objectContaining({
          kind: 'checkpoint',
          checkpointId: actorCheckpointId,
          contentVersion: 1,
        }),
      ])
    );
  });

  it('getSpecHistory surfaces the checkpoint milestone even when specId is cased differently than at seal time (regression, #380 review finding)', async () => {
    const timeline = await getSpecHistory(ids.actorSpec.toUpperCase(), undefined, pool);

    expect(timeline?.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'checkpoint',
          checkpointId: actorCheckpointId,
          contentVersion: 1,
        }),
      ])
    );
  });
});
