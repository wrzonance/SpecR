import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getObjectStructuralSnapshots } from '../index.js';
import type { ObjectBlobNode, ObjectMeta } from '../../ast/index.js';

// #520 — getObjectStructuralSnapshots is the base-side half of structural
// merge-conflict detection: one row per `object` paragraph, carrying its
// parsed ObjectMeta plus its `objectText` interior children's uuids, so
// diff.ts can pair it against `theirs`' freshly-extracted ExtractedObjectBlock
// by objectId. Owner-removed subtrees must drop out exactly like the plain
// paragraph snapshots (versions.ts) they're paired with.

function anchoredParagraph(text: string): ObjectBlobNode {
  return { 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] };
}

function tableMeta(cellCount: number): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: cellCount,
    blob: [
      {
        'w:tbl': Array.from({ length: cellCount }, (_, i) => ({
          'w:tc': [anchoredParagraph(`cell ${i}`)],
        })),
      },
    ],
  };
}

describe('getObjectStructuralSnapshots (#520)', () => {
  let specId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 84', 'Object Structure Query Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  });

  async function insertObject(
    meta: ObjectMeta,
    position: number,
    parentId: string | null = null
  ): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, object_data)
       VALUES ($1, $2, 'object', '', $3, $4::jsonb) RETURNING id`,
      [specId, parentId, position, JSON.stringify(meta)]
    );
    return row.rows[0]!.id;
  }

  async function insertObjectText(
    parentId: string,
    text: string,
    position: number
  ): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, 'objectText', $3, $4) RETURNING id`,
      [specId, parentId, text, position]
    );
    return row.rows[0]!.id;
  }

  it('returns the parsed meta and interior-child uuids in document order for an object with children', async () => {
    const objectId = await insertObject(tableMeta(2), 1);
    const childA = await insertObjectText(objectId, 'first', 2);
    const childB = await insertObjectText(objectId, 'second', 3);

    const snapshots = await getObjectStructuralSnapshots(specId);
    const snapshot = snapshots.find((s) => s.objectId === objectId);

    expect(snapshot?.meta).toEqual(tableMeta(2));
    expect(snapshot?.childUuids).toEqual([childA, childB]);
  });

  it('reports [] (never null) for an object with no objectText children', async () => {
    const objectId = await insertObject(tableMeta(1), 10);

    const snapshots = await getObjectStructuralSnapshots(specId);
    const snapshot = snapshots.find((s) => s.objectId === objectId);

    expect(snapshot?.childUuids).toEqual([]);
  });

  it('returns an empty array for an unknown specId', async () => {
    const snapshots = await getObjectStructuralSnapshots('00000000-0000-0000-0000-0000000000ff');
    expect(snapshots).toEqual([]);
  });

  it('excludes an owner-removed object row and its objectText children (#251/#276 parity)', async () => {
    const keptId = await insertObject(tableMeta(1), 20);
    const removedId = await insertObject(tableMeta(1), 21);
    await pool.query(`UPDATE paragraphs SET vanish = true WHERE id = $1`, [removedId]);
    const removedChild = await insertObjectText(removedId, 'orphaned by removal', 22);

    const snapshots = await getObjectStructuralSnapshots(specId);
    const ids = snapshots.map((s) => s.objectId);

    expect(ids).toContain(keptId);
    expect(ids).not.toContain(removedId);
    // Belt-and-suspenders: the removed object's own child never surfaces as
    // some OTHER object's childUuids entry either.
    expect(snapshots.flatMap((s) => s.childUuids)).not.toContain(removedChild);
  });
});
