import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { rewriteObjectTextBlob } from './object-text-edit.js';
import { findAnchoredParagraph } from '../../parser/index.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { ObjectBlobNode, ObjectMeta } from '../../ast/index.js';

// #519 — rewriteObjectTextBlob is the DB orchestration behind editing an
// `objectText` child paragraph: that node has no text of its own in the
// `paragraphs` table, only a locator (its own id, the SAME uuid baked into
// the `w:sdt` anchor) into its parent `object` row's `object_data.blob`
// (parser/docx/object-blob-edit.ts). Each independent, self-committing
// transaction below mirrors users.integration.test.ts's own concurrent-call
// pattern — NOT held-open transactions raced via Promise.all before commit,
// which self-deadlocks (spike harness-gotcha, see design decision 5).

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

const UUID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_B = '11111111-2222-3333-4444-555555555555';
const UUID_MISSING = '99999999-9999-9999-9999-999999999999';

function anchoredParagraph(uuid: string, text: string): ObjectBlobNode {
  // Structurally the same `w:sdt > w:sdtPr > w:tag` + `w:sdtContent > w:p`
  // shape object-anchor.ts's wrapBlobParagraphWithAnchor produces — built
  // directly here (rather than imported) because db/ may only import
  // parser/'s public barrel, and that helper is an internal parser/docx/
  // export (module-boundary rule).
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }] },
    ],
  } as ObjectBlobNode;
}

function twoCellTableMeta(textA: string, textB: string): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 2,
    blob: [
      { 'w:tc': [anchoredParagraph(UUID_A, textA)] },
      { 'w:tc': [anchoredParagraph(UUID_B, textB)] },
    ],
  };
}

function rewrittenParagraph(text: string): ObjectBlobNode {
  return { 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] };
}

// #650 — an anchored paragraph whose interior carries a run hidden ONLY via
// w:rStyle (named in the object row's own persisted vanishCharStyleIds meta
// field) ahead of an ordinary visible run.
function styleHiddenAnchoredParagraph(
  uuid: string,
  hiddenText: string,
  visibleText: string
): ObjectBlobNode {
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      {
        'w:sdtContent': [
          {
            'w:p': [
              {
                'w:r': [
                  { 'w:rPr': [{ 'w:rStyle': [], ':@': { '@_w:val': 'HiddenChar' } }] },
                  { 'w:t': [{ '#text': hiddenText }] },
                ],
              },
              { 'w:r': [{ 'w:t': [{ '#text': visibleText }] }] },
            ],
          },
        ],
      },
    ],
  } as ObjectBlobNode;
}

function tableMetaWithVanishStyle(hiddenText: string, visibleText: string): ObjectMeta {
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    vanishCharStyleIds: ['HiddenChar'],
    blob: [{ 'w:tc': [styleHiddenAnchoredParagraph(UUID_A, hiddenText, visibleText)] }],
  };
}

describe('rewriteObjectTextBlob — DB orchestration for anchored object-blob edits (#519)', () => {
  let specId: string;

  beforeAll(async () => {
    const lib = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    const libraryId = lib.rows[0]!.id;
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 83', 'Object Text Edit DB Test', 'arcat', $1) RETURNING id`,
      [libraryId]
    );
    specId = spec.rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  });

  async function insertObjectRow(meta: ObjectMeta): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, object_data)
       VALUES ($1, NULL, 'object', '', 1, $2::jsonb) RETURNING id`,
      [specId, JSON.stringify(meta)]
    );
    return row.rows[0]!.id;
  }

  async function objectDataOf(objectId: string): Promise<ObjectMeta> {
    const row = await pool.query<{ object_data: ObjectMeta }>(
      `SELECT object_data FROM paragraphs WHERE id = $1`,
      [objectId]
    );
    return row.rows[0]!.object_data;
  }

  it(
    "invariant: interior text reaches the DOCX only through the parent object row's blob — " +
      'rewrites the anchored paragraph and persists it, leaving the sibling anchor untouched',
    async () => {
      const objectId = await insertObjectRow(twoCellTableMeta('original A', 'original B'));

      await runInTransaction((client) =>
        rewriteObjectTextBlob(client, specId, objectId, UUID_A, 'rewritten A')
      );

      const meta = await objectDataOf(objectId);
      expect(findAnchoredParagraph(meta.blob, UUID_A)).toEqual(rewrittenParagraph('rewritten A'));
      expect(findAnchoredParagraph(meta.blob, UUID_B)).toEqual(rewrittenParagraph('original B'));
    }
  );

  it('throws DatabaseError when parentId does not resolve to an object row in this spec', async () => {
    await expect(
      runInTransaction((client) =>
        rewriteObjectTextBlob(
          client,
          specId,
          '00000000-0000-0000-0000-000000000000',
          UUID_A,
          'unused'
        )
      )
    ).rejects.toThrow(/no object row/);
  });

  it(
    'wraps an unexpected raw pg error (e.g. a malformed parentId the SELECT itself rejects) ' +
      'in DatabaseError with the original error chained as cause, never leaking it unwrapped',
    async () => {
      let caught: unknown;
      try {
        await runInTransaction((client) =>
          rewriteObjectTextBlob(client, specId, 'not-a-valid-uuid', UUID_A, 'unused')
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(DatabaseError);
      expect((caught as Error).message).toMatch(/rewriteObjectTextBlob/);
      expect((caught as Error).cause).toBeDefined();
    }
  );

  it("throws DatabaseError when anchorUuid is not anchored anywhere in the object row's blob", async () => {
    const objectId = await insertObjectRow(twoCellTableMeta('original A', 'original B'));

    await expect(
      runInTransaction((client) =>
        rewriteObjectTextBlob(client, specId, objectId, UUID_MISSING, 'unused')
      )
    ).rejects.toThrow(/anchor/);
  });

  it(
    'invariant: concurrent-safety — concurrent edits to two different anchors within the SAME ' +
      'object row never lose either update (FOR UPDATE serializes the read-modify-write onto ' +
      'the one shared JSONB column)',
    async () => {
      const objectId = await insertObjectRow(twoCellTableMeta('original A', 'original B'));

      // Each edit is an independent, self-committing async function — not a
      // transaction held open and raced via Promise.all before commit (that
      // self-deadlocks: both sides would block forever on the other's FOR
      // UPDATE lock with neither ever reaching COMMIT).
      const editA = (): Promise<void> =>
        runInTransaction((client) =>
          rewriteObjectTextBlob(client, specId, objectId, UUID_A, 'concurrent A')
        );
      const editB = (): Promise<void> =>
        runInTransaction((client) =>
          rewriteObjectTextBlob(client, specId, objectId, UUID_B, 'concurrent B')
        );

      await Promise.all([editA(), editB()]);

      const meta = await objectDataOf(objectId);
      expect(findAnchoredParagraph(meta.blob, UUID_A)).toEqual(rewrittenParagraph('concurrent A'));
      expect(findAnchoredParagraph(meta.blob, UUID_B)).toEqual(rewrittenParagraph('concurrent B'));
    }
  );

  // #650 regression — the exact capture-only-fix gap: without threading the
  // object row's own persisted vanishCharStyleIds into the rewrite path, an
  // edit would land in the w:rStyle-hidden run (invisible in Word) and blank
  // the visible run beside it. rewriteObjectTextBlob must read
  // meta.vanishCharStyleIds and apply the SAME predicate capture used.
  it(
    '#650 regression: rewrite lands the edit in the next VISIBLE run, not a run hidden via ' +
      "w:rStyle — using the object row's own persisted vanishCharStyleIds",
    async () => {
      const objectId = await insertObjectRow(
        tableMetaWithVanishStyle('HIDDEN SECRET', 'visible original')
      );

      await runInTransaction((client) =>
        rewriteObjectTextBlob(client, specId, objectId, UUID_A, 'edited text')
      );

      const meta = await objectDataOf(objectId);
      const found = findAnchoredParagraph(meta.blob, UUID_A);
      const xml = JSON.stringify(found);
      expect(xml).toContain('edited text');
      expect(xml).not.toContain('visible original');
      // the rStyle-hidden run is untouched — neither overwritten nor blanked
      expect(xml).toContain('HIDDEN SECRET');
      // vanishCharStyleIds itself round-trips unchanged alongside the edit
      expect(meta.vanishCharStyleIds).toEqual(['HiddenChar']);
    }
  );

  // #650 — JSONB persistence round-trip: vanishCharStyleIds survives a
  // rewrite byte-identical, alongside every other unrelated meta field.
  it('invariant: vanishCharStyleIds round-trips byte-identical through a rewrite', async () => {
    const meta = tableMetaWithVanishStyle('HIDDEN SECRET', 'original');
    const objectId = await insertObjectRow(meta);

    await runInTransaction((client) =>
      rewriteObjectTextBlob(client, specId, objectId, UUID_A, 'rewritten')
    );

    const after = await objectDataOf(objectId);
    expect(after.vanishCharStyleIds).toEqual(meta.vanishCharStyleIds);
    expect(after.kind).toBe(meta.kind);
    expect(after.rows).toBe(meta.rows);
    expect(after.columns).toBe(meta.columns);
  });

  // #650 — backfill row: a row captured BEFORE this change carries no
  // vanishCharStyleIds key at all. rewriteObjectTextBlob must treat that
  // exactly like an empty set (today's unchanged behaviour), never throw or
  // misbehave on the absent field.
  it('backfill: a row with vanishCharStyleIds entirely absent edits normally, field stays absent', async () => {
    const objectId = await insertObjectRow(twoCellTableMeta('original A', 'original B'));

    await runInTransaction((client) =>
      rewriteObjectTextBlob(client, specId, objectId, UUID_A, 'rewritten A')
    );

    const meta = await objectDataOf(objectId);
    expect(meta.vanishCharStyleIds).toBeUndefined();
    expect(findAnchoredParagraph(meta.blob, UUID_A)).toEqual(rewrittenParagraph('rewritten A'));
  });
});
