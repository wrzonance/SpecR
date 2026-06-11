import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, getParagraphSnapshots } from '../index.js';

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
      `INSERT INTO paragraph_versions (paragraph_id, version, text, node_type)
       VALUES ($1, 1, 'Snapshot pr1 text.', 'pr1')
       ON CONFLICT DO NOTHING`,
      [PR1_ID]
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
      `INSERT INTO paragraph_versions (paragraph_id, version, text, node_type)
       VALUES ($1, 2, 'Future v2 text — must not be returned.', 'pr1')
       ON CONFLICT DO NOTHING`,
      [PR1_ID]
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
