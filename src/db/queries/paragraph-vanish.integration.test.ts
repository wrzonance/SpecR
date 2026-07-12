import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, setParagraphVanish, setVanishRow } from '../index.js';

async function runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function contentVersion(specId: string): Promise<number> {
  const res = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [specId]
  );
  return res.rows[0]?.content_version ?? -1;
}

describe('setParagraphVanish — reversible paragraph removal (#251)', () => {
  let specId: string;
  let nodeId: string;
  let noteId: string;
  let articleId: string;
  let otherSpecId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 81', 'Vanish DB Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
    const node = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Removable paragraph.', 1) RETURNING id`,
      [specId]
    );
    nodeId = node.rows[0]!.id;
    // A note and an article heading — types the renderers cannot suppress, so
    // removal must reject them rather than store a vanish that silently lies.
    const note = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'note', 'Editorial note.', 2) RETURNING id`,
      [specId]
    );
    noteId = note.rows[0]!.id;
    const article = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'article', 'SUMMARY', 3) RETURNING id`,
      [specId]
    );
    articleId = article.rows[0]!.id;
    const other = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 80', 'Vanish DB Other', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    otherSpecId = other.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, otherSpecId]]);
  });

  it('vanishes a paragraph (reversible removal), returning the updated node', async () => {
    const r = await setParagraphVanish(specId, nodeId, true);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBe(true);
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(row.rows[0]!.vanish).toBe(true);
  });

  it('un-vanishes a paragraph (reverses removal)', async () => {
    await setParagraphVanish(specId, nodeId, true);
    const r = await setParagraphVanish(specId, nodeId, false);
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBeUndefined();
  });

  it('returns not-found for an unknown node', async () => {
    const r = await setParagraphVanish(specId, '00000000-0000-0000-0000-000000000000', true);
    expect(r.status).toBe('not-found');
  });

  it('returns wrong-spec when the node belongs to another spec', async () => {
    const r = await setParagraphVanish(otherSpecId, nodeId, true);
    expect(r.status).toBe('wrong-spec');
  });

  it('accepts an uppercase spec UUID (case-insensitive ownership — not a false wrong-spec)', async () => {
    const r = await setParagraphVanish(specId.toUpperCase(), nodeId, true);
    expect(r.status).toBe('updated');
  });

  it('bumps specs.content_version on a successful vanish', async () => {
    await setParagraphVanish(specId, nodeId, false); // ensure an effective change
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    await setParagraphVanish(specId, nodeId, true);
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBeGreaterThan(before.rows[0]!.content_version);
  });

  it('rejects a note node — renderers cannot suppress it (not-removable)', async () => {
    const r = await setParagraphVanish(specId, noteId, true);
    expect(r.status).toBe('not-removable');
    if (r.status === 'not-removable') expect(r.nodeType).toBe('note');
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [noteId]
    );
    expect(row.rows[0]!.vanish).toBe(false); // flag never written
  });

  it('rejects an article heading — renderers cannot suppress it (not-removable)', async () => {
    const r = await setParagraphVanish(specId, articleId, true);
    expect(r.status).toBe('not-removable');
    if (r.status === 'not-removable') expect(r.nodeType).toBe('article');
  });

  it('idempotent no-op: re-removing an already-removed node does not bump content_version', async () => {
    await setParagraphVanish(specId, nodeId, true); // now vanished
    const before = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    const r = await setParagraphVanish(specId, nodeId, true); // no-op
    expect(r.status).toBe('updated');
    if (r.status === 'updated') expect(r.node.meta.vanish).toBe(true);
    const after = await pool.query<{ content_version: number }>(
      `SELECT content_version FROM specs WHERE id = $1`,
      [specId]
    );
    expect(after.rows[0]!.content_version).toBe(before.rows[0]!.content_version);
  });

  it('idempotent no-op: re-restoring an already-restored node does not bump base_version', async () => {
    await setParagraphVanish(specId, nodeId, false); // now restored
    const before = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    const r = await setParagraphVanish(specId, nodeId, false); // no-op
    expect(r.status).toBe('updated');
    const after = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(after.rows[0]!.base_version).toBe(before.rows[0]!.base_version);
  });
});

// setVanishRow is the reusable, gate-free DB core (#374) behind
// setParagraphVanish and (in a later change) the merge engine's deleted-op
// apply. These pin the invariants the extraction must hold: the core never
// gates or bumps content_version — that stays exclusively the caller's job —
// and the toggle is idempotent (a no-op reports changed:false and writes
// nothing), which the merge engine's deleted-op apply relies on to safely
// retry a re-submitted accept without minting a duplicate paragraph_versions
// snapshot.
describe('setVanishRow (DB core, #374)', () => {
  let specId: string;
  let nodeId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 82', 'Vanish Core Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
    const node = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Core-level removable paragraph.', 1) RETURNING id`,
      [specId]
    );
    nodeId = node.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  });

  it('never bumps content_version itself — that is exclusively setParagraphVanish’s job', async () => {
    const versionBefore = await contentVersion(specId);
    const result = await runInTransaction((client) => setVanishRow(client, specId, nodeId, true));
    expect(result.status).toBe('updated');
    if (result.status === 'updated') expect(result.changed).toBe(true);
    expect(await contentVersion(specId)).toBe(versionBefore);
    // restore for the following tests
    await runInTransaction((client) => setVanishRow(client, specId, nodeId, false));
  });

  it('never calls assertSpecWritable — succeeds directly against an archived (gate-rejected) spec', async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const archived = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id, lifecycle_state)
       VALUES ('99 99 83', 'Vanish Core Archived', 'arcat', $1, 'archived') RETURNING id`,
      [libraryId]
    );
    const archivedSpecId = archived.rows[0]!.id;
    const archivedNode = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Archived body.', 1) RETURNING id`,
      [archivedSpecId]
    );
    const archivedNodeId = archivedNode.rows[0]!.id;

    try {
      // If setVanishRow called assertSpecWritable, this would throw
      // SpecWriteForbiddenError instead of returning 'updated' — the archived
      // lifecycle_state gates writes at that layer, not this one.
      const result = await runInTransaction((client) =>
        setVanishRow(client, archivedSpecId, archivedNodeId, true)
      );
      expect(result.status).toBe('updated');
    } finally {
      await pool.query('DELETE FROM specs WHERE id = $1', [archivedSpecId]);
    }
  });

  it('is idempotent: toggling vanish=true on an already-vanished paragraph is a no-op', async () => {
    const first = await runInTransaction((client) => setVanishRow(client, specId, nodeId, true));
    expect(first.status).toBe('updated');
    if (first.status === 'updated') expect(first.changed).toBe(true);

    const baseVersionAfterFirst = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );

    const second = await runInTransaction((client) => setVanishRow(client, specId, nodeId, true));
    expect(second.status).toBe('updated');
    if (second.status === 'updated') {
      expect(second.changed).toBe(false); // no-op: no UPDATE ran
      expect(second.previousText).toBe('Core-level removable paragraph.');
      expect(second.previousNodeType).toBe('pr1');
    }

    const baseVersionAfterSecond = await pool.query<{ base_version: number }>(
      `SELECT base_version FROM paragraphs WHERE id = $1`,
      [nodeId]
    );
    expect(baseVersionAfterSecond.rows[0]!.base_version).toBe(
      baseVersionAfterFirst.rows[0]!.base_version
    );

    // restore for isolation from any later tests
    await runInTransaction((client) => setVanishRow(client, specId, nodeId, false));
  });
});
