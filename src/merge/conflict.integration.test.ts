import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, it, expect, afterAll } from 'vitest';
import { pool, lazyHistoryContext } from '../db/index.js';
import type { ParagraphHistoryContext } from '../db/index.js';
import { applyAccepted, InvalidAcceptedChangeError } from './conflict.js';
import { applyMerge } from './apply-merge.js';
import type { DiffResult } from './types.js';
import type { ObjectStructureFingerprint } from './object-fingerprint.js';
import { findAnchoredParagraph } from '../parser/index.js';
import { UUID_TAG_PREFIX } from '../ast/index.js';
import type { ObjectBlobNode, ObjectMeta } from '../ast/index.js';

// Boundary tests for applyAccepted (#374's added/deleted merge-op support) and,
// for the write-history lockstep invariants (#377, ADR-052 D1), applyMerge — the
// public surfaces conflict.ts and apply-merge.ts expose. Internals
// (applyTextChange, applyAddedChange, applyDeletedChange, sortedAcceptedAdded,
// describeInsertFailure, ...) are deliberately untested directly — every
// invariant below is observable only through applyAccepted/applyMerge's own
// inputs/outputs and the rows they leave behind.

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
  return {
    added: [],
    modified: [],
    deleted: [],
    conflicts: [],
    objectConflicts: [],
    warnings: [],
    ...overrides,
  };
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

/** Every applyAccepted call site in this file needs a lazy
 *  ParagraphHistoryContext resolver (#377, ADR-052 D1) — real callers
 *  (apply-merge.ts) build one exactly once per outer write, immediately after
 *  the gate succeeds, via lazyHistoryContext. These tests bypass the gate
 *  entirely (they call applyAccepted directly, not applyMerge), so there is
 *  no real pre-bump content_version to resolve against; the exact number is
 *  irrelevant to what this file's applyAccepted-level tests assert
 *  (op/uuid/rejection-count/idempotency), so 0 is used uniformly. Tests that
 *  DO care about the real specs.content_version lockstep go through
 *  applyMerge instead (see the 'write-history lockstep' describe block below). */
async function runApplyAccepted<T>(
  fn: (client: PoolClient, resolveCtx: () => Promise<ParagraphHistoryContext>) => Promise<T>
): Promise<T> {
  return runInTransaction(async (client) => {
    return fn(client, lazyHistoryContext(client, 0, undefined));
  });
}

async function contentVersion(specId: string): Promise<number> {
  const res = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [specId]
  );
  return res.rows[0]?.content_version ?? -1;
}

/** True if `label` has ever been resolved through resolveOrCreateUserByLabel
 *  (a row exists in `users`). Used to prove a no-effective-write merge never
 *  triggers the actor upsert (#377 follow-up). */
async function userExists(label: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM users WHERE label = $1', [label]);
  return res.rowCount !== null && res.rowCount > 0;
}

interface HistoryRow {
  readonly version: number;
  readonly text: string;
  readonly nodeType: string;
  readonly op: string;
  readonly specId: string;
  readonly contentVersion: number | null;
  readonly payload: unknown;
}

async function historyRowsFor(paragraphId: string): Promise<readonly HistoryRow[]> {
  const res = await pool.query<{
    version: number;
    text: string;
    node_type: string;
    op: string;
    spec_id: string;
    content_version: number | null;
    payload: unknown;
  }>(
    `SELECT version, text, node_type, op, spec_id, content_version, payload
     FROM paragraph_versions WHERE paragraph_id = $1 ORDER BY version`,
    [paragraphId]
  );
  return res.rows.map((r) => ({
    version: r.version,
    text: r.text,
    nodeType: r.node_type,
    op: r.op,
    specId: r.spec_id,
    contentVersion: r.content_version,
    payload: r.payload,
  }));
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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [unknown], diff, client, ctx))
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

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [pr1Id.toUpperCase()], diff, client, ctx)
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

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [pr1Id], diff, client, ctx)
    );

    expect(result).toEqual({ applied: 1, rejected: 2 });
  });
});

describe('applyAccepted — object-conflict rejection (#520)', () => {
  // Content-blind: only kind/hash need to differ for a divergence, and these
  // tests never call fingerprintBlob/fingerprintsDiverge — the object-conflict
  // rejection path never inspects base/theirs, so any two distinct literals do.
  const baseFingerprint: ObjectStructureFingerprint = {
    kind: 'table',
    rows: 2,
    columns: 2,
    hash: 'a',
  };
  const theirsFingerprint: ObjectStructureFingerprint = {
    kind: 'table',
    rows: 3,
    columns: 2,
    hash: 'b',
  };

  it("rejects accepting an object conflict's own object-row id, making no writes", async () => {
    const { specId, pr1Id } = await createFixture();
    const objectId = randomUUID();
    const diff = diffWith({
      objectConflicts: [
        { objectId, affectedUuids: [pr1Id], base: baseFingerprint, theirs: theirsFingerprint },
      ],
    });

    await expect(
      runApplyAccepted((client, ctx) => applyAccepted(specId, [objectId], diff, client, ctx))
    ).rejects.toThrow(/atomic object-structural conflict/);

    const row = await paragraphRow(pr1Id);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(pr1Id)).toEqual([]);
  });

  it("rejects accepting one of an object conflict's affected child uuids, making no writes", async () => {
    const { specId, pr1Id } = await createFixture();
    const objectId = randomUUID();
    const diff = diffWith({
      objectConflicts: [
        { objectId, affectedUuids: [pr1Id], base: baseFingerprint, theirs: theirsFingerprint },
      ],
    });

    await expect(
      runApplyAccepted((client, ctx) => applyAccepted(specId, [pr1Id], diff, client, ctx))
    ).rejects.toThrow(/atomic object-structural conflict/);

    const row = await paragraphRow(pr1Id);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(pr1Id)).toEqual([]);
  });

  it('an object-conflict uuid rolls back an otherwise-valid accepted uuid from the same call', async () => {
    const { specId, pr1Id, pr1SecondId } = await createFixture();
    const objectId = randomUUID();
    const diff = diffWith({
      deleted: [pr1SecondId],
      objectConflicts: [
        { objectId, affectedUuids: [pr1Id], base: baseFingerprint, theirs: theirsFingerprint },
      ],
    });

    await expect(
      runApplyAccepted((client, ctx) =>
        applyAccepted(specId, [pr1SecondId, objectId], diff, client, ctx)
      )
    ).rejects.toThrow(/atomic object-structural conflict/);

    const row = await paragraphRow(pr1SecondId);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(pr1SecondId)).toEqual([]);
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
      runApplyAccepted((client, ctx) =>
        applyAccepted(specId, [pr1Id, orphanUuid], diff, client, ctx)
      )
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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [orphanUuid], diff, client, ctx))
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

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, accept, diff, client, ctx)
    );

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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [addedUuid], diff, client, ctx))
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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [cellUuid], diff, client, ctx))
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
      runApplyAccepted((client, ctx) =>
        applyAccepted(target.specId, [other.pr1Id], diff, client, ctx)
      )
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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [pr1Id], diff, client, ctx))
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

    const first = await runApplyAccepted((c, ctx) => applyAccepted(specId, [uuidA], diff, c, ctx));
    const second = await runApplyAccepted((c, ctx) => applyAccepted(specId, [uuidB], diff, c, ctx));

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

    const first = await runApplyAccepted((c, ctx) => applyAccepted(specId, [uuidA], diff, c, ctx));
    const second = await runApplyAccepted((c, ctx) =>
      applyAccepted(specId, [uuidA, uuidB], diff, c, ctx)
    );

    expect(first).toEqual({ applied: 1, rejected: 1 });
    // A is an idempotent no-op (exists), B inserts → applied 1, rejected 0.
    expect(second).toEqual({ applied: 1, rejected: 0 });
    const anchorPos = (await paragraphRow(pr1Id)).position;
    expect((await paragraphRow(uuidA)).position).toBe(anchorPos + 1);
    expect((await paragraphRow(uuidB)).position).toBe(anchorPos + 2);
    // A's re-submitted accept resolves to 'exists' (a no-op) — it must not mint
    // a second paragraph_versions row on top of the one its first, real
    // creation already wrote (#377).
    expect(await paragraphVersions(uuidA)).toHaveLength(1);
  });
});

describe('applyAccepted — deleted-op apply', () => {
  it('never hard-deletes: sets vanish=true and snapshots the pre-image to paragraph_versions', async () => {
    const { specId, pr1Id } = await createFixture();
    const diff = diffWith({ deleted: [pr1Id] });

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [pr1Id], diff, client, ctx)
    );

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
      runApplyAccepted((client, ctx) => applyAccepted(specId, [articleId], diff, client, ctx))
    ).rejects.toBeInstanceOf(InvalidAcceptedChangeError);

    const row = await paragraphRow(articleId);
    expect(row.vanish).toBe(false);
    expect(await paragraphVersions(articleId)).toEqual([]);
  });
});

// applyAccepted's write-history capture (#377, ADR-052 D1): every apply
// strategy (text-change, deleted-op, added-op) snapshots a paragraph_versions
// row under op 'merge', tagged with a payload naming which diff bucket it
// resolved. Prior to this, applyAddedChange's 'created' path recorded no
// history at all — the gap #374 left open, closed here.
describe('applyAccepted — write-history capture (#377)', () => {
  it('merge: added-op creation now snapshots a paragraph_versions row (#377)', async () => {
    const { specId, pr1Id } = await createFixture();
    const addedUuid = randomUUID();
    const diff = diffWith({
      added: [{ uuid: addedUuid, text: 'New sibling paragraph', index: 0, afterUuid: pr1Id }],
    });

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [addedUuid], diff, client, ctx)
    );

    expect(result).toEqual({ applied: 1, rejected: 0 });
    const rows = await historyRowsFor(addedUuid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      text: 'New sibling paragraph',
      nodeType: 'pr1',
      op: 'merge',
      specId,
    });
    expect(rows[0]?.payload).toEqual({ kind: 'merge', diffKind: 'added' });
  });

  it('tags a modified-op snapshot payload diffKind "modified", a conflict-op "conflict"', async () => {
    const { specId, pr1Id, pr1SecondId } = await createFixture();
    const diff = diffWith({
      modified: [{ uuid: pr1Id, base: PR1_TEXT, theirs: 'Modified via /diff', ours: PR1_TEXT }],
      conflicts: [
        {
          uuid: pr1SecondId,
          base: PR1_SECOND_TEXT,
          theirs: 'Resolved conflict',
          ours: PR1_SECOND_TEXT,
        },
      ],
    });

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [pr1Id, pr1SecondId], diff, client, ctx)
    );

    expect(result).toEqual({ applied: 2, rejected: 0 });
    const modifiedRows = await historyRowsFor(pr1Id);
    expect(modifiedRows[0]?.payload).toEqual({ kind: 'merge', diffKind: 'modified' });
    const conflictRows = await historyRowsFor(pr1SecondId);
    expect(conflictRows[0]?.payload).toEqual({ kind: 'merge', diffKind: 'conflict' });
  });
});

// applyMerge's write-history lockstep (#377, ADR-052 D1): unlike the
// applyAccepted-level tests above (which resolve an arbitrary ctx to isolate
// applyAccepted's own behavior), these go through the full engine — the real
// composed edit gate + resolveHistoryContext + bumpSpecContentVersion — so the
// content_version stamped on every row can be checked against the real,
// post-commit specs.content_version.
describe('applyMerge — write-history lockstep (#377)', () => {
  it('every applied change in one merge call stamps content_version == specs.content_version post-commit, one row per paragraph', async () => {
    const { specId, pr1Id, pr1SecondId } = await createFixture();
    const addedUuid = randomUUID();
    const diff = diffWith({
      deleted: [pr1Id],
      added: [{ uuid: addedUuid, text: 'Lockstep addition', index: 0, afterUuid: pr1SecondId }],
    });

    const before = await contentVersion(specId);
    const outcome = await applyMerge(specId, [pr1Id, addedUuid], diff, undefined);
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') expect(outcome).toMatchObject({ applied: 2, rejected: 0 });

    // ONE outer write → content_version advances exactly once, no matter how
    // many paragraph_versions rows it produced.
    const after = await contentVersion(specId);
    expect(after).toBe(before + 1);

    const deletedRows = await historyRowsFor(pr1Id);
    expect(deletedRows).toHaveLength(1);
    expect(deletedRows[0]?.contentVersion).toBe(after);

    const addedRows = await historyRowsFor(addedUuid);
    expect(addedRows).toHaveLength(1);
    expect(addedRows[0]?.contentVersion).toBe(after);
  });

  it('a no-op merge apply (theirs already matches current text) writes zero paragraph_versions rows and does not bump content_version', async () => {
    const { specId, pr1SecondId } = await createFixture();
    const diff = diffWith({
      modified: [
        {
          uuid: pr1SecondId,
          base: PR1_SECOND_TEXT,
          theirs: PR1_SECOND_TEXT,
          ours: PR1_SECOND_TEXT,
        },
      ],
    });

    const before = await contentVersion(specId);
    const outcome = await applyMerge(specId, [pr1SecondId], diff, undefined);

    expect(outcome).toMatchObject({ kind: 'applied', applied: 0, rejected: 0 });
    expect(await contentVersion(specId)).toBe(before); // no effective write → no bump
    expect(await historyRowsFor(pr1SecondId)).toHaveLength(0);
  });

  it('a re-submitted added-op accept (exists — already materialized) writes zero additional rows', async () => {
    const { specId, pr1Id } = await createFixture();
    const addedUuid = randomUUID();
    const diff = diffWith({
      added: [{ uuid: addedUuid, text: 'Idempotent addition', index: 0, afterUuid: pr1Id }],
    });

    const first = await applyMerge(specId, [addedUuid], diff, undefined);
    expect(first).toMatchObject({ kind: 'applied', applied: 1 });
    expect(await historyRowsFor(addedUuid)).toHaveLength(1);

    const before = await contentVersion(specId);
    const second = await applyMerge(specId, [addedUuid], diff, undefined);

    expect(second).toMatchObject({ kind: 'applied', applied: 0, rejected: 0 });
    expect(await contentVersion(specId)).toBe(before); // no-op re-submit → no bump
    expect(await historyRowsFor(addedUuid)).toHaveLength(1); // still exactly one row
  });

  it('a re-submitted deleted-op accept (already vanished) writes zero additional rows', async () => {
    const { specId, pr1Id } = await createFixture();
    const diff = diffWith({ deleted: [pr1Id] });

    const first = await applyMerge(specId, [pr1Id], diff, undefined);
    expect(first).toMatchObject({ kind: 'applied', applied: 1 });
    expect(await historyRowsFor(pr1Id)).toHaveLength(1);

    const before = await contentVersion(specId);
    const second = await applyMerge(specId, [pr1Id], diff, undefined);

    expect(second).toMatchObject({ kind: 'applied', applied: 0, rejected: 0 });
    expect(await contentVersion(specId)).toBe(before); // no-op re-submit → no bump
    expect(await historyRowsFor(pr1Id)).toHaveLength(1); // still exactly one row
  });
});

// applyMerge must not resolve (and thereby upsert) an actor's users row until
// it is known the merge makes an effective write — mirroring applyVanish/
// runInsert/runAccept, which all defer resolveHistoryContext past their own
// no-op guard. Resolving eagerly, right after the gate, would mint a users
// row for actorLabel even when nothing in the accept array actually changes
// anything (code review finding on #377, ADR-052 D1).
describe('applyMerge — defers actor resolution until an effective write (#377 follow-up)', () => {
  it('accept=[] resolves no actor and creates no users row', async () => {
    const { specId } = await createFixture();
    const actorLabel = `unused-actor-${randomUUID()}`;
    const diff = diffWith({});

    const outcome = await applyMerge(specId, [], diff, undefined, actorLabel);

    expect(outcome).toMatchObject({ kind: 'applied', applied: 0, rejected: 0 });
    expect(await userExists(actorLabel)).toBe(false);
  });

  it('a merge where every accepted change is a no-op creates no users row for a fresh actor', async () => {
    const { specId, pr1SecondId } = await createFixture();
    const actorLabel = `unused-actor-${randomUUID()}`;
    const diff = diffWith({
      modified: [
        {
          uuid: pr1SecondId,
          base: PR1_SECOND_TEXT,
          theirs: PR1_SECOND_TEXT,
          ours: PR1_SECOND_TEXT,
        },
      ],
    });

    const outcome = await applyMerge(specId, [pr1SecondId], diff, undefined, actorLabel);

    expect(outcome).toMatchObject({ kind: 'applied', applied: 0, rejected: 0 });
    expect(await userExists(actorLabel)).toBe(false);
  });

  it('a merge with a real effective write still resolves and attributes the actor', async () => {
    const { specId, pr1Id } = await createFixture();
    const actorLabel = `real-actor-${randomUUID()}`;
    const diff = diffWith({ deleted: [pr1Id] });

    const outcome = await applyMerge(specId, [pr1Id], diff, undefined, actorLabel);

    expect(outcome).toMatchObject({ kind: 'applied', applied: 1, rejected: 0 });
    expect(await userExists(actorLabel)).toBe(true);
  });
});

// #520 review finding: applyTextChange must rewrite the owning object row's
// object_data.blob when the accepted uuid resolves to an objectText row —
// generator/object-block.ts re-emits that blob verbatim, never
// paragraphs.text, so an edit applied only via the plain UPDATE above is
// silently dropped from the next generated DOCX. Mirrors
// paragraphs.integration.test.ts's own "object write path (#519)" coverage
// of updateParagraphText, for the parallel merge-accept path.
const OBJECT_TEXT_ORIGINAL = 'Cell interior text.';

function anchoredCellBlob(uuid: string, text: string): ObjectBlobNode {
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }] },
    ],
  } as ObjectBlobNode;
}

function tableObjectMeta(anchorUuid: string, text: string): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    blob: [{ 'w:tc': [anchoredCellBlob(anchorUuid, text)] }],
  };
}

interface ObjectFixture {
  readonly specId: string;
  readonly objectId: string;
  readonly objectTextId: string;
}

async function createObjectFixture(): Promise<ObjectFixture> {
  const specId = randomUUID();
  const partId = randomUUID();
  const objectId = randomUUID();
  const objectTextId = randomUUID();
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, '09 91 26', 'Conflict Object Apply Test', $2,
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))`,
    [specId, `d520_${randomUUID().slice(0, 8)}`]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, NULL, 'part', 'GENERAL', 1)`,
    [partId, specId]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, object_data)
     VALUES ($1, $2, $3, 'object', '', 1, $4::jsonb)`,
    [objectId, specId, partId, JSON.stringify(tableObjectMeta(objectTextId, OBJECT_TEXT_ORIGINAL))]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, 'objectText', $4, 1)`,
    [objectTextId, specId, objectId, OBJECT_TEXT_ORIGINAL]
  );
  cleanupIds.push(specId);
  return { specId, objectId, objectTextId };
}

async function objectBlobOf(objectId: string): Promise<readonly ObjectBlobNode[]> {
  const row = await pool.query<{ object_data: ObjectMeta }>(
    'SELECT object_data FROM paragraphs WHERE id = $1',
    [objectId]
  );
  return row.rows[0]!.object_data.blob;
}

describe('applyAccepted — objectText write path (#520 review finding)', () => {
  it(
    "accepting a modified-op against an objectText uuid rewrites the parent object row's " +
      'object_data.blob (not just paragraphs.text) — otherwise the accepted edit never reaches ' +
      'the next generated DOCX (generator/object-block.ts re-emits object_data.blob verbatim)',
    async () => {
      const { specId, objectId, objectTextId } = await createObjectFixture();
      const revisedText = 'Revised cell interior text.';
      const diff = diffWith({
        modified: [
          {
            uuid: objectTextId,
            base: OBJECT_TEXT_ORIGINAL,
            theirs: revisedText,
            ours: OBJECT_TEXT_ORIGINAL,
          },
        ],
      });

      const result = await runApplyAccepted((client, ctx) =>
        applyAccepted(specId, [objectTextId], diff, client, ctx)
      );

      expect(result).toEqual({ applied: 1, rejected: 0 });
      const textRow = await pool.query<{ text: string }>(
        'SELECT text FROM paragraphs WHERE id = $1',
        [objectTextId]
      );
      expect(textRow.rows[0]!.text).toBe(revisedText);
      const blob = await objectBlobOf(objectId);
      expect(findAnchoredParagraph(blob, objectTextId)).toEqual({
        'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': revisedText }] }] }],
      });
    }
  );

  it('accepting a conflict-op against an objectText uuid also rewrites the parent blob', async () => {
    const { specId, objectId, objectTextId } = await createObjectFixture();
    const resolvedText = 'Manually resolved cell text.';
    const diff = diffWith({
      conflicts: [
        {
          uuid: objectTextId,
          base: OBJECT_TEXT_ORIGINAL,
          theirs: resolvedText,
          ours: OBJECT_TEXT_ORIGINAL,
        },
      ],
    });

    const result = await runApplyAccepted((client, ctx) =>
      applyAccepted(specId, [objectTextId], diff, client, ctx)
    );

    expect(result).toEqual({ applied: 1, rejected: 0 });
    const blob = await objectBlobOf(objectId);
    expect(findAnchoredParagraph(blob, objectTextId)).toEqual({
      'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': resolvedText }] }] }],
    });
  });

  it('throws when an objectText row somehow has no parent object row (data-integrity guard)', async () => {
    const specId = randomUUID();
    const orphanId = randomUUID();
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '09 91 27', 'Conflict Object Orphan Test', $2,
               (SELECT id FROM libraries WHERE name = 'Default Company Master'))`,
      [specId, `d520o_${randomUUID().slice(0, 8)}`]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'objectText', 'orphan', 1)`,
      [orphanId, specId]
    );
    cleanupIds.push(specId);
    const diff = diffWith({
      modified: [{ uuid: orphanId, base: 'orphan', theirs: 'new text', ours: 'orphan' }],
    });

    await expect(
      runApplyAccepted((client, ctx) => applyAccepted(specId, [orphanId], diff, client, ctx))
    ).rejects.toThrow(/has no parent object row/);
  });
});
