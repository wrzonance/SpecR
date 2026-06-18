import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pool, acquireLock, releaseLock, getLock } from '../index.js';

const SPEC_ID = 'c0000000-0000-0000-0000-0000000000a1';
const HOLDER_A = 'user:alice';
const HOLDER_B = 'user:bob';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id)
     VALUES ($1, '99 98 00', 'Locks Test', 'arcat',
             (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     ON CONFLICT (id) DO NOTHING`,
    [SPEC_ID]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [SPEC_ID]);
});

beforeEach(async () => {
  await pool.query('DELETE FROM spec_locks WHERE spec_id = $1', [SPEC_ID]);
});

/** Force the live lock to be expired so we can test steal-after-expiry. */
async function expireLock(specId: string): Promise<void> {
  await pool.query(
    `UPDATE spec_locks SET expires_at = now() - interval '1 second' WHERE spec_id = $1`,
    [specId]
  );
}

describe('acquireLock', () => {
  it('acquires a lock on a free spec', async () => {
    const result = await acquireLock(SPEC_ID, HOLDER_A, 900);
    expect(result.status).toBe('acquired');
  });

  it('refuses a second holder while the lock is live, surfacing the current holder', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    const result = await acquireLock(SPEC_ID, HOLDER_B, 900);
    expect(result.status).toBe('held');
    if (result.status === 'held') {
      expect(result.holder).toBe(HOLDER_A);
      expect(result.expiresAt).toBeTypeOf('string');
    }
  });

  it('lets the same holder re-acquire (refresh) while live', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    const result = await acquireLock(SPEC_ID, HOLDER_A, 900);
    expect(result.status).toBe('acquired');
  });

  it('lets a second holder steal the lock after expiry', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    await expireLock(SPEC_ID);
    const result = await acquireLock(SPEC_ID, HOLDER_B, 900);
    expect(result.status).toBe('acquired');
    const current = await getLock(SPEC_ID);
    expect(current?.holder).toBe(HOLDER_B);
  });
});

describe('releaseLock', () => {
  it('lets the holder release its own lock', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    const result = await releaseLock(SPEC_ID, HOLDER_A);
    expect(result.released).toBe(true);
    expect(await getLock(SPEC_ID)).toBeNull();
  });

  it('refuses release by a non-holder and leaves the lock intact', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    const result = await releaseLock(SPEC_ID, HOLDER_B);
    expect(result.released).toBe(false);
    expect((await getLock(SPEC_ID))?.holder).toBe(HOLDER_A);
  });
});

describe('getLock', () => {
  it('returns null when no lock exists', async () => {
    expect(await getLock(SPEC_ID)).toBeNull();
  });

  it('returns null when the lock has expired (treated as free)', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    await expireLock(SPEC_ID);
    expect(await getLock(SPEC_ID)).toBeNull();
  });

  it('returns the live lock with holder and expiry', async () => {
    await acquireLock(SPEC_ID, HOLDER_A, 900);
    const lock = await getLock(SPEC_ID);
    expect(lock?.holder).toBe(HOLDER_A);
    expect(lock?.expiresAt).toBeTypeOf('string');
  });
});
