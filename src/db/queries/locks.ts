import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';

/** ADR-018 D2 — advisory soft locks with TTL.
 *
 * "Someone is editing this section" visibility, not pessimistic checkout
 * (ADR-005). There is no unlock ceremony: an abandoned lock expires and the
 * next caller steals it. `holder` is a caller-supplied label until auth (#43)
 * supplies an authenticated identity. */

interface Queryable {
  query: Pool['query'];
}

/** Default time-to-live for an acquired lock — 15 minutes. Long enough for a
 *  human edit session, short enough that an abandoned lock never wedges a spec
 *  for an unreasonable time before it can be stolen. */
export const DEFAULT_LOCK_TTL_SECONDS = 900;

export interface LockState {
  readonly holder: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export type AcquireLockResult =
  | { readonly status: 'acquired'; readonly lock: LockState }
  | { readonly status: 'held'; readonly holder: string; readonly expiresAt: string };

interface LockRow {
  readonly holder: string;
  readonly acquired_at: Date;
  readonly expires_at: Date;
}

function toLockState(row: LockRow): LockState {
  return {
    holder: row.holder,
    acquiredAt: row.acquired_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

/** Acquire (or refresh, or steal-after-expiry) the advisory lock on a spec.
 *  One UPSERT does all three: the row is written when the spec is free, when
 *  the caller already holds it, or when the existing lock has expired; a live
 *  lock held by someone else makes the UPDATE branch a no-op (the WHERE fails),
 *  and we then read back the blocking holder. */
export async function acquireLock(
  specId: string,
  holder: string,
  ttlSeconds: number = DEFAULT_LOCK_TTL_SECONDS,
  db: Queryable = pool
): Promise<AcquireLockResult> {
  try {
    const inserted = await db.query<LockRow>(
      `INSERT INTO spec_locks (spec_id, holder, acquired_at, expires_at)
       VALUES ($1, $2, now(), now() + ($3 || ' seconds')::interval)
       ON CONFLICT (spec_id) DO UPDATE
         SET holder = EXCLUDED.holder,
             acquired_at = EXCLUDED.acquired_at,
             expires_at = EXCLUDED.expires_at
         WHERE spec_locks.holder = EXCLUDED.holder
            OR spec_locks.expires_at <= now()
       RETURNING holder, acquired_at, expires_at`,
      [specId, holder, String(ttlSeconds)]
    );
    const row = inserted.rows[0];
    if (row) return { status: 'acquired', lock: toLockState(row) };

    // No row returned → the ON CONFLICT WHERE refused: a live lock is held by
    // someone else. Read it back so the caller learns who blocks them.
    const current = await db.query<LockRow>(
      'SELECT holder, acquired_at, expires_at FROM spec_locks WHERE spec_id = $1',
      [specId]
    );
    const held = current.rows[0];
    if (!held) {
      throw new DatabaseError('acquireLock: lock refused but no holder found (race)');
    }
    return { status: 'held', holder: held.holder, expiresAt: held.expires_at.toISOString() };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`acquireLock: failed for spec ${specId}`, { cause: err });
  }
}

/** Release the lock only if the caller holds it. Returns released:false when
 *  no row was deleted (no lock, or held by another) — never an error, so the
 *  caller can map it to a clean 409. */
export async function releaseLock(
  specId: string,
  holder: string,
  db: Queryable = pool
): Promise<{ readonly released: boolean }> {
  try {
    const result = await db.query('DELETE FROM spec_locks WHERE spec_id = $1 AND holder = $2', [
      specId,
      holder,
    ]);
    return { released: (result.rowCount ?? 0) > 0 };
  } catch (err) {
    throw new DatabaseError(`releaseLock: failed for spec ${specId}`, { cause: err });
  }
}

/** Current live lock, or null when none exists or the lock has expired (an
 *  expired lock is indistinguishable from "free" to a reader). */
export async function getLock(specId: string, db: Queryable = pool): Promise<LockState | null> {
  try {
    const result = await db.query<LockRow>(
      `SELECT holder, acquired_at, expires_at FROM spec_locks
       WHERE spec_id = $1 AND expires_at > now()`,
      [specId]
    );
    const row = result.rows[0];
    return row ? toLockState(row) : null;
  } catch (err) {
    throw new DatabaseError(`getLock: failed for spec ${specId}`, { cause: err });
  }
}
