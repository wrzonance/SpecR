import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, insertParagraphAfter, insertSiblingRow, StaleVersionError } from '../index.js';
import { historyRowsFor } from '../../test-utils/history-rows.js';
import { SYSTEM_ACTOR_LABEL } from './paragraph-history.js';

const SPEC_ID = 'c1000000-0000-0000-0000-000000000000';
const OTHER_SPEC_ID = 'c1000000-0000-0000-0000-00000000000f';
const PART_ID = 'c1000000-0000-0000-0000-000000000001';
const ART_ID = 'c1000000-0000-0000-0000-000000000002';
const PR1_FIRST_ID = 'c1000000-0000-0000-0000-000000000003';
const PR1_MIDDLE_ID = 'c1000000-0000-0000-0000-000000000004';
const PR1_LAST_ID = 'c1000000-0000-0000-0000-000000000005';
const NOTE_ID = 'c1000000-0000-0000-0000-000000000006';
const CONT_ID = 'c1000000-0000-0000-0000-000000000007';

async function contentVersion(specId: string): Promise<number> {
  const res = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [specId]
  );
  return res.rows[0]?.content_version ?? -1;
}

async function positionOf(nodeId: string): Promise<number> {
  const res = await pool.query<{ position: number }>(
    'SELECT position FROM paragraphs WHERE id = $1',
    [nodeId]
  );
  return res.rows[0]?.position ?? -1;
}

async function countParagraphsWithId(id: string): Promise<number> {
  const res = await pool.query<{ count: string }>('SELECT count(*) FROM paragraphs WHERE id = $1', [
    id,
  ]);
  return Number(res.rows[0]?.count ?? '0');
}

/** Runs `fn` inside its own BEGIN/COMMIT — insertSiblingRow is a gate-free,
 *  transaction-managed-by-caller DB core, so exercising it directly (rather
 *  than through insertParagraphAfter) requires owning the transaction here. */
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

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, $2, $3, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID, '99 99 01', 'Insert Test']
  );
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, $2, $3, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     ON CONFLICT (id) DO NOTHING`,
    [OTHER_SPEC_ID, '99 99 02', 'Insert Test Other']
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,NULL,'part','GENERAL',1) ON CONFLICT (id) DO NOTHING`,
    [PART_ID, SPEC_ID]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'article','SCOPE',1) ON CONFLICT (id) DO NOTHING`,
    [ART_ID, SPEC_ID, PART_ID]
  );
  for (const [id, text, position] of [
    [PR1_FIRST_ID, 'First paragraph.', 1],
    [PR1_MIDDLE_ID, 'Middle paragraph.', 2],
    [PR1_LAST_ID, 'Last paragraph.', 3],
  ] as const) {
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1,$2,$3,'pr1',$4,$5) ON CONFLICT (id) DO NOTHING`,
      [id, SPEC_ID, ART_ID, text, position]
    );
  }
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'note','A specifier note.',4) ON CONFLICT (id) DO NOTHING`,
    [NOTE_ID, SPEC_ID, ART_ID]
  );
  // A continuation sitting among the article's pr1 children — it continues the
  // preceding pr1's text and carries no tier of its own (#383).
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1,$2,$3,'continuation','…continued text.',5) ON CONFLICT (id) DO NOTHING`,
    [CONT_ID, SPEC_ID, ART_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[SPEC_ID, OTHER_SPEC_ID]]);
});

describe('insertParagraphAfter', () => {
  it('inserts a sibling after the anchor, defaulting to the anchor type, and shifts followers', async () => {
    const versionBefore = await contentVersion(SPEC_ID);
    const lastPosBefore = await positionOf(PR1_LAST_ID);

    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_MIDDLE_ID,
      text: 'Inserted after middle.',
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('pr1');
    expect(result.node.text).toBe('Inserted after middle.');
    expect(result.node.children).toEqual([]);
    expect(result.node.meta).toEqual({});

    // sits directly after the anchor, under the same parent
    const row = await pool.query<{ parent_id: string; position: number }>(
      'SELECT parent_id, position FROM paragraphs WHERE id = $1',
      [result.node.id]
    );
    expect(row.rows[0]?.parent_id).toBe(ART_ID);
    expect(row.rows[0]?.position).toBe((await positionOf(PR1_MIDDLE_ID)) + 1);
    // the follower shifted down one slot
    expect(await positionOf(PR1_LAST_ID)).toBe(lastPosBefore + 1);
    // a content write bumps the optimistic-concurrency version
    expect(await contentVersion(SPEC_ID)).toBe(versionBefore + 1);
  });

  it('shifts every follower, not just one, when inserting before multiple siblings', async () => {
    // anchor is the FIRST paragraph, so both middle and last are followers —
    // exercises the multi-row `position > $anchorPosition` shift a single
    // trailing follower can't catch.
    const middlePosBefore = await positionOf(PR1_MIDDLE_ID);
    const lastPosBefore = await positionOf(PR1_LAST_ID);

    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Inserted after first.',
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(await positionOf(PR1_MIDDLE_ID)).toBe(middlePosBefore + 1);
    expect(await positionOf(PR1_LAST_ID)).toBe(lastPosBefore + 1);
  });

  it('honors an explicit nodeType that matches the sibling-compatibility rule', async () => {
    // 'continuation' is legal at any tier (#383 rule 2) — pr2 is NOT, because
    // pr2 nests as a pr1's CHILD, not as pr1's sibling (see the cross-tier
    // rejection tests below).
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Explicitly a continuation.',
      nodeType: 'continuation',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('continuation');
  });

  it('inserts a sibling article when the anchor is an article', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: ART_ID,
      text: 'NEW ARTICLE',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('article');
    const row = await pool.query<{ parent_id: string }>(
      'SELECT parent_id FROM paragraphs WHERE id = $1',
      [result.node.id]
    );
    expect(row.rows[0]?.parent_id).toBe(PART_ID);
  });

  it('refuses the defaulted type when the anchor is a part', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PART_ID,
      text: 'Should not become a part.',
    });
    expect(result).toEqual({ status: 'invalid-type', nodeType: 'part' });
  });

  it('refuses an explicit insertable type when the anchor is a part — a root node has no sibling', async () => {
    // Without the root guard, an explicit nodeType slips past the insertable
    // check and lands an article at parent_id = NULL — a root node the
    // renderers mislabel as a PART, breaking round-trip.
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PART_ID,
      text: 'Should not become a root-level article.',
      nodeType: 'article',
    });
    expect(result).toEqual({ status: 'invalid-type', nodeType: 'article' });
  });

  it('rejects a pr1 requested after an article anchor — would orphan the pr1 under the article, skipping the pr1 tier it belongs at (#383)', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: ART_ID,
      text: 'Should not become a mis-tiered pr1.',
      nodeType: 'pr1',
    });
    expect(result).toEqual({ status: 'invalid-type', nodeType: 'pr1' });
  });

  it('rejects an article requested after a pr1 anchor — would land an article as a pr1-tier sibling instead of a part child (#383)', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Should not become a mis-tiered article.',
      nodeType: 'article',
    });
    expect(result).toEqual({ status: 'invalid-type', nodeType: 'article' });
  });

  it('rejects a pr2 requested after a pr1 anchor — pr2 nests as a pr1 child, never as a pr1 sibling (#383)', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Should not become a mis-tiered pr2.',
      nodeType: 'pr2',
    });
    expect(result).toEqual({ status: 'invalid-type', nodeType: 'pr2' });
  });

  // KNOWN AMBIGUITY (#383): a note carries no CSI tier of its own — it cannot
  // constrain what tier follows it, so any already-insertable type is accepted
  // after a note anchor. This is deliberate permissiveness, not an oversight;
  // see isSiblingCompatible's doc comment in paragraph-insert.ts.
  it('accepts any insertable explicit type after a note anchor — KNOWN AMBIGUITY: a note has no tier to mismatch against (#383)', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: NOTE_ID,
      text: 'A pr3 after a note.',
      nodeType: 'pr3',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('pr3');
  });

  // KNOWN AMBIGUITY (#383): a continuation is the OTHER tierless anchor — it
  // continues the preceding node's text and inherits that node's tier rather
  // than stating one, so like a note it cannot constrain what tier follows it.
  // A pr1 after a continuation that itself follows a pr1 is ordinary,
  // well-formed content; rejecting it refused a legitimate insert.
  it('accepts an explicit pr1 after a continuation anchor — KNOWN AMBIGUITY: a continuation inherits its tier and has none of its own to mismatch against (#383)', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: CONT_ID,
      text: 'A pr1 after a continuation.',
      nodeType: 'pr1',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('pr1');
  });

  it('reports not-found for an unknown anchor', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: 'c1000000-0000-0000-0000-0000000000aa',
      text: 'No anchor.',
    });
    expect(result).toEqual({ status: 'not-found' });
  });

  it('reports wrong-spec when the anchor belongs to another spec', async () => {
    const result = await insertParagraphAfter(OTHER_SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Wrong spec.',
    });
    expect(result).toEqual({ status: 'wrong-spec' });
  });

  it('accepts an uppercase specId — pg returns spec_id lowercased, so an unfolded compare would false-403', async () => {
    // z.uuid() preserves an uppercase specId, but `pg` hands back
    // anchor.spec_id lowercased; without case-folding both sides the string
    // compare misfires and a valid write reports wrong-spec.
    const result = await insertParagraphAfter(SPEC_ID.toUpperCase(), {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Uppercase specId.',
    });
    expect(result.status).toBe('created');
  });

  it('rejects a stale expectedVersion with StaleVersionError', async () => {
    await expect(
      insertParagraphAfter(SPEC_ID, {
        anchorNodeId: PR1_FIRST_ID,
        text: 'Stale write.',
        expectedVersion: 999999,
      })
    ).rejects.toBeInstanceOf(StaleVersionError);
  });

  it('accepts a matching expectedVersion', async () => {
    const version = await contentVersion(SPEC_ID);
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Conditional write.',
      expectedVersion: version,
    });
    expect(result.status).toBe('created');
  });
});

// insertSiblingRow is the reusable, gate-free DB core (#374) behind
// insertParagraphAfter and (in a later change) the merge engine's added-op
// apply. These pin the invariants the extraction must hold: the explicitId
// idempotency pre-check runs under the anchor lock strictly before any
// sibling-position shift, and the core never gates or bumps content_version —
// that stays exclusively the caller's job.
describe('insertSiblingRow (DB core, #374)', () => {
  it('short-circuits a retried explicitId to "exists" before any position shift or duplicate row — the sole idempotency mechanism', async () => {
    const explicitId = 'c1000000-0000-0000-0000-0000000000bb';
    const lastPosBefore = await positionOf(PR1_LAST_ID);

    const first = await runInTransaction((client) =>
      insertSiblingRow(client, SPEC_ID, {
        anchorNodeId: PR1_FIRST_ID,
        text: 'Retryable insert.',
        explicitId,
      })
    );
    expect(first.status).toBe('created');
    if (first.status !== 'created') return;
    expect(first.node.id).toBe(explicitId);
    expect(await positionOf(PR1_LAST_ID)).toBe(lastPosBefore + 1);
    expect(await countParagraphsWithId(explicitId)).toBe(1);

    // A retry (same explicitId, e.g. a re-submitted merge accept) must observe
    // the first attempt's row under the anchor lock and skip BOTH the shift
    // and the insert entirely — not just avoid a duplicate row.
    const second = await runInTransaction((client) =>
      insertSiblingRow(client, SPEC_ID, {
        anchorNodeId: PR1_FIRST_ID,
        text: 'Retryable insert.',
        explicitId,
      })
    );
    expect(second).toEqual({ status: 'exists', id: explicitId });
    expect(await positionOf(PR1_LAST_ID)).toBe(lastPosBefore + 1); // no second shift
    expect(await countParagraphsWithId(explicitId)).toBe(1); // no duplicate row
  });

  it('never bumps content_version itself — that is exclusively insertParagraphAfter’s job', async () => {
    const versionBefore = await contentVersion(SPEC_ID);
    const result = await runInTransaction((client) =>
      insertSiblingRow(client, SPEC_ID, {
        anchorNodeId: PR1_MIDDLE_ID,
        text: 'Core insert, no bump.',
      })
    );
    expect(result.status).toBe('created');
    expect(await contentVersion(SPEC_ID)).toBe(versionBefore);
  });

  it('never calls assertSpecWritable — succeeds directly against an archived (gate-rejected) spec', async () => {
    const archivedSpecId = 'c1000000-0000-0000-0000-0000000000cc';
    const archivedPartId = 'c1000000-0000-0000-0000-0000000000cd';
    const archivedBodyId = 'c1000000-0000-0000-0000-0000000000ce';
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id, lifecycle_state)
       VALUES ($1, '99 99 03', 'Archived Insert Test', 'arcat',
               (SELECT id FROM libraries WHERE name = 'Default Company Master'), 'archived')
       ON CONFLICT (id) DO NOTHING`,
      [archivedSpecId]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'part', 'GENERAL', 1) ON CONFLICT (id) DO NOTHING`,
      [archivedPartId, archivedSpecId]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, $3, 'pr1', 'Body.', 1) ON CONFLICT (id) DO NOTHING`,
      [archivedBodyId, archivedSpecId, archivedPartId]
    );

    try {
      // If insertSiblingRow called assertSpecWritable, this would throw
      // SpecWriteForbiddenError instead of returning 'created' — the archived
      // lifecycle_state gates writes at that layer, not this one.
      const result = await runInTransaction((client) =>
        insertSiblingRow(client, archivedSpecId, {
          anchorNodeId: archivedBodyId,
          text: 'Gate is the caller’s job, not the core’s.',
        })
      );
      expect(result.status).toBe('created');
    } finally {
      await pool.query('DELETE FROM specs WHERE id = $1', [archivedSpecId]);
    }
  });
});

describe('insertParagraphAfter — version history capture (#377)', () => {
  it('version-history: insert records a creation row (#377)', async () => {
    const versionBefore = await contentVersion(SPEC_ID);

    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_MIDDLE_ID,
      text: 'History-tracked insert.',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    // Exactly one new paragraph_versions row per write.
    const rows = await historyRowsFor(pool, result.node.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      text: 'History-tracked insert.',
      node_type: 'pr1',
      op: 'insert',
      spec_id: SPEC_ID,
      content_version: versionBefore + 1,
    });
    expect(rows[0]?.payload).toEqual({
      kind: 'insert',
      parentId: ART_ID,
      position: result.position,
    });

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1 AND v.version = 1`,
      [result.node.id]
    );
    expect(joined.rows[0]?.label).toBe(SYSTEM_ACTOR_LABEL);
  });

  it('stamps the resolved actorLabel on the creation row as a real users row', async () => {
    const actorLabel = 'ph-actor-paragraph-insert-test';
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_MIDDLE_ID,
      text: 'History-tracked insert, named actor.',
      actorLabel,
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1 AND v.version = 1`,
      [result.node.id]
    );
    try {
      expect(joined.rows[0]?.label).toBe(actorLabel);
    } finally {
      // Run cleanup even if the assertion throws — a leaked users row (label is
      // UNIQUE) would fail later runs that re-claim it.
      await pool.query('DELETE FROM users WHERE label = $1', [actorLabel]);
    }
  });

  it('a no-op (rejected) insert writes zero paragraph_versions rows', async () => {
    const before = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM paragraph_versions WHERE spec_id = $1',
      [SPEC_ID]
    );

    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PART_ID,
      text: 'Should not become a part.',
    });
    expect(result.status).toBe('invalid-type');

    const after = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM paragraph_versions WHERE spec_id = $1',
      [SPEC_ID]
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
