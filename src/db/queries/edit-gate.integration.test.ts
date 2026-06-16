import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  pool,
  assertSpecWritable,
  SpecWriteForbiddenError,
  StaleVersionError,
  SpecNotFoundError,
} from '../index.js';

const SPEC_ID = 'c0000000-0000-0000-0000-0000000000b1';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, '99 97 00', 'Edit Gate Test', 'arcat',
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

beforeEach(async () => {
  await pool.query(
    `UPDATE specs SET lifecycle_state = 'draft', external_state = 'editable', content_version = 1
     WHERE id = $1`,
    [SPEC_ID]
  );
});

async function currentVersion(): Promise<number> {
  const r = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [SPEC_ID]
  );
  return r.rows[0]!.content_version;
}

describe('assertSpecWritable', () => {
  it('returns the current version for a writable draft spec', async () => {
    const result = await assertSpecWritable(pool, SPEC_ID);
    expect(result.contentVersion).toBe(await currentVersion());
  });

  it('passes when expectedVersion matches the current version', async () => {
    const result = await assertSpecWritable(pool, SPEC_ID, 1);
    expect(result.contentVersion).toBe(1);
  });

  it('rejects a stale expectedVersion with the current version attached', async () => {
    await pool.query('UPDATE specs SET content_version = 5 WHERE id = $1', [SPEC_ID]);
    await expect(assertSpecWritable(pool, SPEC_ID, 2)).rejects.toBeInstanceOf(StaleVersionError);
    try {
      await assertSpecWritable(pool, SPEC_ID, 2);
    } catch (err) {
      expect(err).toBeInstanceOf(StaleVersionError);
      if (err instanceof StaleVersionError) expect(err.currentVersion).toBe(5);
    }
  });

  it('rejects writes to an archived spec', async () => {
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [SPEC_ID]);
    await expect(assertSpecWritable(pool, SPEC_ID)).rejects.toBeInstanceOf(SpecWriteForbiddenError);
  });

  it('allows writes to an issued spec (snapshot is the immutable thing, not the draft)', async () => {
    await pool.query(`UPDATE specs SET lifecycle_state = 'issued' WHERE id = $1`, [SPEC_ID]);
    const result = await assertSpecWritable(pool, SPEC_ID);
    expect(result.contentVersion).toBeTypeOf('number');
  });

  it('rejects writes when external_state is not editable (composed gate)', async () => {
    await pool.query(`UPDATE specs SET external_state = 'locked' WHERE id = $1`, [SPEC_ID]);
    await expect(assertSpecWritable(pool, SPEC_ID)).rejects.toBeInstanceOf(SpecWriteForbiddenError);
  });

  it('throws SpecNotFoundError for an unknown spec', async () => {
    await expect(
      assertSpecWritable(pool, '00000000-0000-0000-0000-000000000000')
    ).rejects.toBeInstanceOf(SpecNotFoundError);
  });
});
