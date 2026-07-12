import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { applyAccepted, InvalidAcceptedChangeError } from './conflict.js';
import type { DiffResult } from './types.js';

// Boundary tests for applyAccepted (#374's added/deleted merge-op support): the
// public surface conflict.ts exposes. Internals (applyTextChange, applyAddedChange,
// applyDeletedChange, sortedAcceptedAdded, describeInsertFailure, ...) are
// deliberately untested directly — every invariant below is observable only
// through applyAccepted's own inputs/outputs and the rows it leaves behind.

const PR1_TEXT = 'Original body text.';
const PR1_SECOND_TEXT = 'Second body text.';

const cleanupIds: string[] = [];

interface Fixture {
  readonly specId: string;
  readonly partId: string;
  readonly articleId: string;
  readonly pr1Id: string;
  readonly pr1SecondId: string;
}

async function createFixture(): Promise<Fixture> {
  const specId = randomUUID();
  const partId = randomUUID();
  const articleId = randomUUID();
  const pr1Id = randomUUID();
  const pr1SecondId = randomUUID();
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, '27 17 00', 'Conflict Apply Test', $2,
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))`,
    [specId, `d374_${randomUUID().slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, NULL, 'part', 'GENERAL', 1)`,
    [partId, specId]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, 'article', 'SCOPE', 1)`,
    [articleId, specId, partId]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, 'pr1', $4, 1)`,
    [pr1Id, specId, articleId, PR1_TEXT]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, 'pr1', $4, 2)`,
    [pr1SecondId, specId, articleId, PR1_SECOND_TEXT]
  );
  cleanupIds.push(specId);
  return { specId, partId, articleId, pr1Id, pr1SecondId };
}

afterAll(async () => {
  if (cleanupIds.length > 0) await pool.query('DELETE FROM specs WHERE id = ANY($1)', [cleanupIds]);
});

function diffWith(overrides: Partial<DiffResult>): DiffResult {
  return { added: [], modified: [], deleted: [], conflicts: [], warnings: [], ...overrides };
}

/** Owns the transaction applyAccepted runs inside — mirrors apply-merge.ts's
 *  caller contract (BEGIN before, COMMIT/ROLLBACK after). A thrown error rolls
 *  back everything the call did, proving applyAccepted never commits partial
 *  work itself. */
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

async function paragraphRow(id: string): Promise<{
  readonly exists: boolean;
  readonly vanish: boolean;
  readonly baseVersion: number;
  readonly position: number;
  readonly text: string;
}> {
  const res = await pool.query<{
    vanish: boolean;
    base_version: number;
    position: number;
    text: string;
  }>('SELECT vanish, base_version, position, text FROM paragraphs WHERE id = $1', [id]);
  const row = res.rows[0];
  if (!row) return { exists: false, vanish: false, baseVersion: -1, position: -1, text: '' };
  return {
    exists: true,
    vanish: row.vanish,
    baseVersion: row.base_version,
    position: row.position,
    text: row.text,
  };
}

async function paragraphVersions(
  paragraphId: string
): Promise<
  readonly { readonly text: string; readonly nodeType: string; readonly version: number }[]
> {
  const res = await pool.query<{ text: string; node_type: string; version: number }>(
    'SELECT text, node_type, version FROM paragraph_versions WHERE paragraph_id = $1 ORDER BY version',
    [paragraphId]
  );
  return res.rows.map((r) => ({ text: r.text, nodeType: r.node_type, version: r.version }));
}

describe('applyAccepted — validation (#374)', () => {
  it('rejects any accepted uuid not present in applicableChanges(diff), making no writes', async () => {
    const { specId, pr1Id } = await createFixture();
    const diff = diffWith({ deleted: [pr1Id] });
    const unknown = randomUUID();

    await expect(
      runInTransaction((client) => applyAccepted(specId, [unknown], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    const row = await paragraphRow(pr1Id);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(pr1Id)).toEqual([]);
  });

  it('resolves a case-variant accepted uuid to its diff entry (uuids are case-insensitive)', async () => {
    // get_spec_diff emits canonical lowercase uuids; a client that re-cases one in
    // `accept` must still resolve to the same entry, not be rejected as unknown —
    // PostgreSQL and z.uuid() both treat the two casings as one uuid.
    const { specId, pr1Id } = await createFixture();
    const diff = diffWith({ deleted: [pr1Id] });

    const result = await runInTransaction((client) =>
      applyAccepted(specId, [pr1Id.toUpperCase()], diff, client)
    );

    expect(result).toEqual({ applied: 1, rejected: 0 });
    expect((await paragraphRow(pr1Id)).vanish).toBe(true);
  });

  it('rejected = applicable.size - accepted.length', async () => {
    const { specId, pr1Id, pr1SecondId, articleId } = await createFixture();
    const addedUuid = randomUUID();
    const diff = diffWith({
      deleted: [pr1Id],
      modified: [{ uuid: pr1SecondId, base: PR1_SECOND_TEXT, theirs: 'x', ours: PR1_SECOND_TEXT }],
      added: [{ uuid: addedUuid, text: 'New paragraph', index: 0, afterUuid: articleId }],
    });

    const result = await runInTransaction((client) => applyAccepted(specId, [pr1Id], diff, client));

    expect(result).toEqual({ applied: 1, rejected: 2 });
  });
});

describe('applyAccepted — atomicity', () => {
  it('a mid-call failure rolls back every write the call made, inside the caller-owned transaction', async () => {
    const { specId, pr1Id } = await createFixture();
    // deleted-op is valid and applies first (modified/deleted apply inline,
    // before the batched added-op pass); the added-op has no anchor and must
    // fail the whole call — the earlier vanish must not survive the rollback.
    const orphanUuid = randomUUID();
    const diff = diffWith({
      deleted: [pr1Id],
      added: [{ uuid: orphanUuid, text: 'Orphan', index: 0, afterUuid: undefined }],
    });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [pr1Id, orphanUuid], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    const row = await paragraphRow(pr1Id);
    expect(row.vanish).toBe(false); // rolled back, not left half-applied
    expect(await paragraphVersions(pr1Id)).toEqual([]);
  });
});

describe('applyAccepted — added-op apply', () => {
  it('an added-op with afterUuid undefined throws and is never silently placed or dropped', async () => {
    const { specId } = await createFixture();
    const orphanUuid = randomUUID();
    const diff = diffWith({
      added: [{ uuid: orphanUuid, text: 'Orphan', index: 0, afterUuid: undefined }],
    });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [orphanUuid], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    expect((await paragraphRow(orphanUuid)).exists).toBe(false);
  });

  it('sibling added-ops sharing one anchor apply in diff.index order, regardless of accept-array order', async () => {
    const { specId, articleId, pr1Id } = await createFixture();
    const uuidLater = randomUUID(); // higher index — comes SECOND in document order
    const uuidEarlier = randomUUID(); // lower index — comes FIRST in document order
    const diff = diffWith({
      added: [
        { uuid: uuidLater, text: 'Later', index: 7, afterUuid: pr1Id },
        { uuid: uuidEarlier, text: 'Earlier', index: 3, afterUuid: pr1Id },
      ],
    });
    // Accept array lists the LATER uuid first — apply order must still follow
    // diff.index, not accept-array order.
    const accept = [uuidLater, uuidEarlier];

    const result = await runInTransaction((client) => applyAccepted(specId, accept, diff, client));

    expect(result).toEqual({ applied: 2, rejected: 0 });
    const anchorPos = (await paragraphRow(pr1Id)).position;
    const earlierRow = await paragraphRow(uuidEarlier);
    const laterRow = await paragraphRow(uuidLater);
    // final document order: anchor, Earlier, Later — Later chains off Earlier's
    // newly-created row rather than re-anchoring on the original pr1Id.
    expect(earlierRow.position).toBe(anchorPos + 1);
    expect(laterRow.position).toBe(anchorPos + 2);

    const article = await pool.query<{ node_type: string }>(
      'SELECT node_type FROM paragraphs WHERE id = $1',
      [articleId]
    );
    expect(article.rows[0]?.node_type).toBe('article'); // sanity: fixture intact
  });

  it('rejects an added-op anchored on a structural (article) node instead of minting a sibling article', async () => {
    const { specId, articleId } = await createFixture();
    const addedUuid = randomUUID();
    const diff = diffWith({
      added: [
        {
          uuid: addedUuid,
          text: 'Orphan after the article heading',
          index: 0,
          afterUuid: articleId,
        },
      ],
    });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [addedUuid], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    expect((await paragraphRow(addedUuid)).exists).toBe(false);
    // the fixture's single article is untouched — no second sibling article was minted
    const articles = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1 AND node_type = 'article'`,
      [specId]
    );
    expect(articles.rows[0]?.count).toBe('1');
  });

  it('rejects a table-cell orphan the extractor left anchorless (afterUuid undefined), never flattening it', async () => {
    const { specId } = await createFixture();
    const cellUuid = randomUUID();
    // extract.ts gives every table-cell paragraph afterUuid undefined (#374); such an
    // addition must be rejected at apply, not silently placed as a body sibling.
    const diff = diffWith({
      added: [{ uuid: cellUuid, text: 'Table cell content', index: 0, afterUuid: undefined }],
    });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [cellUuid], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    expect((await paragraphRow(cellUuid)).exists).toBe(false);
  });

  it('rejects an added-op whose uuid already exists in a DIFFERENT spec (400-class, not a 500)', async () => {
    const target = await createFixture();
    const other = await createFixture();
    // Reuse a paragraph id living in `other` as the explicit id of an addition into
    // `target`. The paragraphs PK is global, so the pre-check must catch the foreign
    // row rather than let ON CONFLICT DO NOTHING surface as a DatabaseError → 500.
    const diff = diffWith({
      added: [{ uuid: other.pr1Id, text: 'Cross-spec orphan', index: 0, afterUuid: target.pr1Id }],
    });

    await expect(
      runInTransaction((client) => applyAccepted(target.specId, [other.pr1Id], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);
  });

  it('rejects an added-op reusing a same-spec uuid with different text (a stale/tampered diff, not a retry)', async () => {
    const { specId, pr1Id, pr1SecondId } = await createFixture();
    // pr1Id already exists with PR1_TEXT; an addition claiming that uuid but other
    // text is not an idempotent retry (which matches text) — reject it.
    const diff = diffWith({
      added: [{ uuid: pr1Id, text: 'Totally different text', index: 0, afterUuid: pr1SecondId }],
    });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [pr1Id], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);
    // the existing row is untouched
    expect((await paragraphRow(pr1Id)).text).toBe(PR1_TEXT);
  });
});

describe('applyAccepted — split / re-submitted added-op accept (#374)', () => {
  it('accepting [A] then [B] across two calls still lands P, A, B in diff.index order', async () => {
    const { specId, pr1Id } = await createFixture();
    const uuidA = randomUUID(); // index 3 — earlier in document order
    const uuidB = randomUUID(); // index 7 — later
    const diff = diffWith({
      added: [
        { uuid: uuidA, text: 'A', index: 3, afterUuid: pr1Id },
        { uuid: uuidB, text: 'B', index: 7, afterUuid: pr1Id },
      ],
    });

    const first = await runInTransaction((c) => applyAccepted(specId, [uuidA], diff, c));
    const second = await runInTransaction((c) => applyAccepted(specId, [uuidB], diff, c));

    expect(first).toEqual({ applied: 1, rejected: 1 });
    expect(second).toEqual({ applied: 1, rejected: 1 });
    const anchorPos = (await paragraphRow(pr1Id)).position;
    // B chains off A (resolved from committed DB state) rather than re-anchoring on
    // P — without the fix a split accept lands P, B, A (inverted).
    expect((await paragraphRow(uuidA)).position).toBe(anchorPos + 1);
    expect((await paragraphRow(uuidB)).position).toBe(anchorPos + 2);
  });

  it('re-submitting [A, B] after A already applied inserts only B and keeps P, A, B order', async () => {
    const { specId, pr1Id } = await createFixture();
    const uuidA = randomUUID();
    const uuidB = randomUUID();
    const diff = diffWith({
      added: [
        { uuid: uuidA, text: 'A', index: 3, afterUuid: pr1Id },
        { uuid: uuidB, text: 'B', index: 7, afterUuid: pr1Id },
      ],
    });

    const first = await runInTransaction((c) => applyAccepted(specId, [uuidA], diff, c));
    const second = await runInTransaction((c) => applyAccepted(specId, [uuidA, uuidB], diff, c));

    expect(first).toEqual({ applied: 1, rejected: 1 });
    // A is an idempotent no-op (exists), B inserts → applied 1, rejected 0.
    expect(second).toEqual({ applied: 1, rejected: 0 });
    const anchorPos = (await paragraphRow(pr1Id)).position;
    expect((await paragraphRow(uuidA)).position).toBe(anchorPos + 1);
    expect((await paragraphRow(uuidB)).position).toBe(anchorPos + 2);
  });
});

describe('applyAccepted — deleted-op apply', () => {
  it('never hard-deletes: sets vanish=true and snapshots the pre-image to paragraph_versions', async () => {
    const { specId, pr1Id } = await createFixture();
    const diff = diffWith({ deleted: [pr1Id] });

    const result = await runInTransaction((client) => applyAccepted(specId, [pr1Id], diff, client));

    expect(result).toEqual({ applied: 1, rejected: 0 });
    const row = await paragraphRow(pr1Id);
    expect(row.exists).toBe(true);
    expect(row.vanish).toBe(true);
    expect(row.baseVersion).toBe(2);
    expect(await paragraphVersions(pr1Id)).toEqual([
      { text: PR1_TEXT, nodeType: 'pr1', version: 2 },
    ]);
  });

  it('a deleted-op on a non-removable node type throws, never cascading or silently dropping', async () => {
    const { specId, articleId } = await createFixture();
    const diff = diffWith({ deleted: [articleId] });

    await expect(
      runInTransaction((client) => applyAccepted(specId, [articleId], diff, client))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    const row = await paragraphRow(articleId);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(articleId)).toEqual([]);
  });
});
