import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphSnapshots, getCurrentParagraphSnapshots } from '../index.js';

const SPEC_ID = 'e3400000-0000-0000-0000-000000000000';
const PART_ID = 'e3400000-0000-0000-0000-000000000001';
const ART_ID = 'e3400000-0000-0000-0000-000000000002';
const PR1_ID = 'e3400000-0000-0000-0000-000000000003';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, $2, $3, $4, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID, '99 99 34', 'Versions Query Test', 'arcat']
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $4, NULL, 'part', 'GENERAL', 1),
            ($2, $4, $1, 'article', 'SCOPE', 2),
            ($3, $4, $2, 'pr1', 'Current pr1 text.', 3)
     ON CONFLICT (id) DO NOTHING`,
    [PART_ID, ART_ID, PR1_ID, SPEC_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

describe('getParagraphSnapshots', () => {
  it('falls back to paragraphs.text when no snapshot row exists', async () => {
    const rows = await getParagraphSnapshots(SPEC_ID);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ uuid: PART_ID, text: 'GENERAL', baseVersion: 1 });
    expect(rows[2]).toEqual({ uuid: PR1_ID, text: 'Current pr1 text.', baseVersion: 1 });
  });

  it('returns the snapshot text when a paragraph_versions row matches base_version', async () => {
    await pool.query(
      `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op)
       VALUES ($1, $2, 1, 'Snapshot pr1 text.', 'pr1', 'merge')
       ON CONFLICT DO NOTHING`,
      [PR1_ID, SPEC_ID]
    );
    const rows = await getParagraphSnapshots(SPEC_ID);
    const pr1 = rows.find((r) => r.uuid === PR1_ID);
    expect(pr1).toEqual({ uuid: PR1_ID, text: 'Snapshot pr1 text.', baseVersion: 1 });
    const part = rows.find((r) => r.uuid === PART_ID);
    expect(part?.text).toBe('GENERAL'); // others still on fallback
  });

  it('returns an empty array for an unknown specId', async () => {
    const rows = await getParagraphSnapshots('00000000-0000-0000-0000-0000000000ff');
    expect(rows).toEqual([]);
  });

  it('ignores snapshot rows whose version does not match base_version', async () => {
    await pool.query(
      `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op)
       VALUES ($1, $2, 2, 'Future v2 text — must not be returned.', 'pr1', 'merge')
       ON CONFLICT DO NOTHING`,
      [PR1_ID, SPEC_ID]
    );
    const rows = await getParagraphSnapshots(SPEC_ID);
    // Without AND v.version = p.base_version the join produces a duplicate row for PR1
    // (one for each version row), so total would be 4 instead of 3.
    expect(rows).toHaveLength(3);
    const pr1 = rows.find((r) => r.uuid === PR1_ID);
    // base_version is still 1 → the v1 snapshot wins; v2 row is invisible
    expect(pr1).toEqual({ uuid: PR1_ID, text: 'Snapshot pr1 text.', baseVersion: 1 });
  });
});

// #251/#276: owner-removed body paragraphs are omitted from the generated DOCX, so
// they must be omitted from the merge snapshots too — otherwise the diff path
// (computeSpecDiff) reports them as a false hard deletion. A vanished NOTE, by
// contrast, is still rendered (controlled in the DOCX) and must remain.
describe('merge snapshots exclude owner-removed subtrees (#251/#276)', () => {
  const SNAP_SPEC = 'e3400000-0000-0000-0000-0000000000a0';
  const KEPT = 'e3400000-0000-0000-0000-0000000000a1';
  const REMOVED = 'e3400000-0000-0000-0000-0000000000a2'; // vanished pr1 with a child
  const REMOVED_CHILD = 'e3400000-0000-0000-0000-0000000000a4'; // pr2 under REMOVED
  const VANISHED_NOTE = 'e3400000-0000-0000-0000-0000000000a3';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '99 99 35', 'Snapshot Vanish Test', 'arcat',
               (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       ON CONFLICT (id) DO NOTHING`,
      [SNAP_SPEC]
    );
    // REMOVED is a vanished pr1; REMOVED_CHILD is its non-vanished pr2 descendant.
    // The renderers skip the whole subtree, so both must drop from the snapshots.
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, vanish)
       VALUES ($1, $5, NULL, 'pr1', 'Kept paragraph.', 1, false),
              ($2, $5, NULL, 'pr1', 'Removed paragraph.', 2, true),
              ($4, $5, $2,   'pr2', 'Child of removed.', 3, false),
              ($3, $5, NULL, 'note', 'Editorial note.', 4, true)
       ON CONFLICT (id) DO NOTHING`,
      [KEPT, REMOVED, VANISHED_NOTE, REMOVED_CHILD, SNAP_SPEC]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [SNAP_SPEC]);
  });

  it('getParagraphSnapshots drops the removed node AND its subtree, keeps the vanished note', async () => {
    const rows = await getParagraphSnapshots(SNAP_SPEC);
    const ids = rows.map((r) => r.uuid);
    expect(ids).toContain(KEPT);
    expect(ids).toContain(VANISHED_NOTE); // rendered → stays
    expect(ids).not.toContain(REMOVED); // owner-removed root → excluded
    expect(ids).not.toContain(REMOVED_CHILD); // descendant of removed → excluded
  });

  it('getCurrentParagraphSnapshots drops the removed node AND its subtree, keeps the vanished note', async () => {
    const rows = await getCurrentParagraphSnapshots(SNAP_SPEC);
    const ids = rows.map((r) => r.uuid);
    expect(ids).toContain(KEPT);
    expect(ids).toContain(VANISHED_NOTE);
    expect(ids).not.toContain(REMOVED);
    expect(ids).not.toContain(REMOVED_CHILD);
  });
});

// #377 / ADR-052 D1 — paragraph_versions capture extension (migration 046).
describe('migration 046 — paragraph_versions capture columns', () => {
  const CAP_SPEC = 'e3400000-0000-0000-0000-0000000000c0';
  const CAP_PARA = 'e3400000-0000-0000-0000-0000000000c1';
  const ALL_OPS = [
    'edit',
    'insert',
    'remove',
    'restore',
    'merge',
    'accept-note',
    'restructure',
  ] as const;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO specs (id, section, title, source, library_id)
       VALUES ($1, '99 99 37', 'Capture Columns Test', 'arcat',
               (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       ON CONFLICT (id) DO NOTHING`,
      [CAP_SPEC]
    );
    await pool.query(
      `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
       VALUES ($1, $2, NULL, 'pr1', 'Capture test paragraph.', 1)
       ON CONFLICT (id) DO NOTHING`,
      [CAP_PARA, CAP_SPEC]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [CAP_SPEC]);
  });

  it('db: op CHECK rejects a value outside the ADR-052 D1 seven-value enum', async () => {
    await expect(
      pool.query(
        `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op)
         VALUES ($1, $2, 999, 'x', 'pr1', 'not-a-real-op')`,
        [CAP_PARA, CAP_SPEC]
      )
    ).rejects.toThrow(/paragraph_versions_op_check/);
  });

  it.each(ALL_OPS)('db: op CHECK accepts %s', async (op) => {
    const inserted = await pool.query(
      `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op)
       VALUES ($1, $2, 100, 'x', 'pr1', $3) RETURNING op`,
      [CAP_PARA, CAP_SPEC, op]
    );
    expect(inserted.rows[0]).toEqual({ op });
    await pool.query('DELETE FROM paragraph_versions WHERE paragraph_id = $1 AND version = 100', [
      CAP_PARA,
    ]);
  });

  it('db: deleting a users row SETs paragraph_versions.user_id NULL, never touches its content', async () => {
    // Defensive: a prior aborted run of this test can leave the label behind
    // (users.label is UNIQUE) — clear it before (re-)claiming it.
    await pool.query(`DELETE FROM users WHERE label = 'capture-test-actor'`);
    const userResult = await pool.query<{ id: string }>(
      `INSERT INTO users (label) VALUES ('capture-test-actor') RETURNING id`
    );
    const userId = userResult.rows[0]?.id;
    expect(userId).toBeTruthy();
    const versionResult = await pool.query<{ id: string }>(
      `INSERT INTO paragraph_versions (paragraph_id, spec_id, version, text, node_type, op, user_id)
       VALUES ($1, $2, 101, 'Attributed snapshot text.', 'pr1', 'edit', $3) RETURNING id`,
      [CAP_PARA, CAP_SPEC, userId]
    );
    const versionId = versionResult.rows[0]?.id;

    await pool.query('DELETE FROM users WHERE id = $1', [userId]);

    const after = await pool.query<{ user_id: string | null; text: string; node_type: string }>(
      'SELECT user_id, text, node_type FROM paragraph_versions WHERE id = $1',
      [versionId]
    );
    expect(after.rows).toEqual([
      { user_id: null, text: 'Attributed snapshot text.', node_type: 'pr1' },
    ]);

    const paragraphStillThere = await pool.query('SELECT id FROM paragraphs WHERE id = $1', [
      CAP_PARA,
    ]);
    expect(paragraphStillThere.rows).toHaveLength(1);
  });
});
