import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, insertParagraphAfter, StaleVersionError } from '../index.js';

const SPEC_ID = 'c1000000-0000-0000-0000-000000000000';
const OTHER_SPEC_ID = 'c1000000-0000-0000-0000-00000000000f';
const PART_ID = 'c1000000-0000-0000-0000-000000000001';
const ART_ID = 'c1000000-0000-0000-0000-000000000002';
const PR1_FIRST_ID = 'c1000000-0000-0000-0000-000000000003';
const PR1_MIDDLE_ID = 'c1000000-0000-0000-0000-000000000004';
const PR1_LAST_ID = 'c1000000-0000-0000-0000-000000000005';

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

  it('honors an explicit nodeType', async () => {
    const result = await insertParagraphAfter(SPEC_ID, {
      anchorNodeId: PR1_FIRST_ID,
      text: 'Explicitly a pr2.',
      nodeType: 'pr2',
    });
    expect(result.status).toBe('created');
    if (result.status !== 'created') return;
    expect(result.node.type).toBe('pr2');
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
