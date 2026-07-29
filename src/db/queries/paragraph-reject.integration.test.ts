import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  pool,
  updateParagraphText,
  insertParagraphAfter,
  rejectParagraphToCheckpoint,
} from '../index.js';
import { createCheckpoint } from './checkpoints.js';
import { historyRowsFor } from '../../test-utils/history-rows.js';

// ADR-052 D4 (issue #380, task 7) — rejectParagraphToCheckpoint against a real
// Postgres instance: the revert must actually overwrite current text, discard
// a concurrent edit made after the checkpoint sealed WITHOUT ever consulting
// expectedVersion, and be itself recorded as a new paragraph_versions row —
// never a silent no-op.
//
// Namespace reserved by this file: a dedicated spec/paragraph tree labeled
// '99 99 9x' cleaned up in afterAll.

async function contentVersion(specId: string): Promise<number> {
  const res = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [specId]
  );
  return res.rows[0]?.content_version ?? -1;
}

async function currentText(paragraphId: string): Promise<string> {
  const res = await pool.query<{ text: string }>('SELECT text FROM paragraphs WHERE id = $1', [
    paragraphId,
  ]);
  return res.rows[0]?.text ?? '';
}

describe('rejectParagraphToCheckpoint (#380 task 7, ADR-052 D4)', () => {
  let libraryId: string;
  let specId: string;
  let otherSpecId: string;
  let nodeId: string;
  let userId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 91', 'Reject DB Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
    const other = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 92', 'Reject DB Other', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    otherSpecId = other.rows[0]!.id;
    const node = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Original text.', 1) RETURNING id`,
      [specId]
    );
    nodeId = node.rows[0]!.id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (label) VALUES ($1) RETURNING id`,
      [`paragraph-reject-test-${randomUUID().slice(0, 8)}`]
    );
    userId = user.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM checkpoints WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  it('reverts to the checkpointed text, discarding a later concurrent edit unconditionally — always a new history row', async () => {
    // Seal the paragraph's first edit into a checkpoint.
    const sealed = await updateParagraphText(specId, nodeId, 'Sealed text (checkpoint state)');
    expect(sealed.status).toBe('updated');
    const checkpoint = await createCheckpoint(
      { name: 'reject-test-seal', scope: 'spec', scopeId: specId, userId },
      pool
    );

    // Two pending edits land AFTER the checkpoint — the second simulates a
    // concurrent editor whose change the reject must discard without ever
    // consulting an expectedVersion (there is none to consult: this call
    // supplies none, exactly like a real concurrent editor's own PATCH would
    // have advanced base_version independently of this call).
    await updateParagraphText(specId, nodeId, 'Pending edit one.');
    await updateParagraphText(specId, nodeId, 'Concurrent pending edit two.');
    expect(await currentText(nodeId)).toBe('Concurrent pending edit two.');

    const historyBefore = await historyRowsFor(pool, nodeId);
    expect(historyBefore).toHaveLength(3); // the seal + the two pending edits

    const result = await rejectParagraphToCheckpoint(specId, nodeId, checkpoint.id);

    expect(result.status).toBe('reverted');
    if (result.status === 'reverted') {
      expect(result.node.text).toBe('Sealed text (checkpoint state)');
    }
    expect(await currentText(nodeId)).toBe('Sealed text (checkpoint state)');

    // The revert is itself a new, fully visible history row — never a silent
    // no-op, regardless of the intervening concurrent edits.
    const historyAfter = await historyRowsFor(pool, nodeId);
    expect(historyAfter).toHaveLength(4);
    expect(historyAfter[3]).toMatchObject({
      text: 'Sealed text (checkpoint state)',
      op: 'edit',
      spec_id: specId,
    });
  });

  it('returns checkpoint-not-found for an unknown checkpoint id', async () => {
    const result = await rejectParagraphToCheckpoint(specId, nodeId, randomUUID());
    expect(result).toEqual({ status: 'checkpoint-not-found' });
  });

  it('returns checkpoint-not-found for a checkpoint that never sealed this spec', async () => {
    const foreignCheckpoint = await createCheckpoint(
      { name: 'reject-test-foreign', scope: 'spec', scopeId: otherSpecId, userId },
      pool
    );
    const result = await rejectParagraphToCheckpoint(specId, nodeId, foreignCheckpoint.id);
    expect(result).toEqual({ status: 'checkpoint-not-found' });
  });

  it('returns not-found for an unknown paragraph', async () => {
    const checkpoint = await createCheckpoint(
      { name: 'reject-test-notfound', scope: 'spec', scopeId: specId, userId },
      pool
    );
    const result = await rejectParagraphToCheckpoint(
      specId,
      '00000000-0000-0000-0000-000000000000',
      checkpoint.id
    );
    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns wrong-spec when the paragraph belongs to a different spec than the checkpoint sealed', async () => {
    const otherNode = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Other spec paragraph.', 1) RETURNING id`,
      [otherSpecId]
    );
    const otherNodeId = otherNode.rows[0]!.id;
    await updateParagraphText(otherSpecId, otherNodeId, 'Edited in other spec.');

    const checkpoint = await createCheckpoint(
      { name: 'reject-test-wrongspec', scope: 'spec', scopeId: specId, userId },
      pool
    );
    const result = await rejectParagraphToCheckpoint(specId, otherNodeId, checkpoint.id);
    expect(result).toEqual({ status: 'wrong-spec' });
  });

  it('returns no-checkpointed-state for a paragraph inserted after the checkpoint sealed', async () => {
    const checkpoint = await createCheckpoint(
      { name: 'reject-test-nostate', scope: 'spec', scopeId: specId, userId },
      pool
    );
    const inserted = await insertParagraphAfter(specId, {
      anchorNodeId: nodeId,
      text: 'Inserted after the checkpoint.',
    });
    expect(inserted.status).toBe('created');
    if (inserted.status !== 'created') return;

    const result = await rejectParagraphToCheckpoint(specId, inserted.node.id, checkpoint.id);
    expect(result).toEqual({ status: 'no-checkpointed-state' });
  });

  it('returns locked-object when the checkpointed paragraph is an object row', async () => {
    const objectNode = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'object', 'Object blob text.', 5) RETURNING id`,
      [specId]
    );
    const objectNodeId = objectNode.rows[0]!.id;
    // Object rows never go through updateParagraphText (that is the whole
    // point of the lock) — seed a snapshot directly, mirroring
    // history.integration.test.ts's fixture-seeding convention.
    await pool.query(
      `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op, content_version)
       VALUES ($1, $2, 1, 'Object blob text.', 'object', 'insert', $3)`,
      [objectNodeId, specId, await contentVersion(specId)]
    );
    const checkpoint = await createCheckpoint(
      { name: 'reject-test-lockedobject', scope: 'spec', scopeId: specId, userId },
      pool
    );

    const result = await rejectParagraphToCheckpoint(specId, objectNodeId, checkpoint.id);
    expect(result).toEqual({ status: 'locked-object', nodeType: 'object' });
  });
});
