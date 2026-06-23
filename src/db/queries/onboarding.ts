import type { PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { getConventionForLibrary, seedLibraryConventionIfAbsent } from './conventions.js';

export type OnboardingStatus = 'review' | 'active';

export interface FinalizeOutcome {
  readonly status: 'finalized' | 'already-active' | 'not-found';
}

export interface ReopenOutcome {
  readonly status: 'reopened' | 'already-review' | 'not-found';
}

interface StatusRow {
  readonly onboarding_status: OnboardingStatus;
  readonly library_id: string | null;
}

export async function getOnboardingStatus(specId: string): Promise<OnboardingStatus | null> {
  try {
    const res = await pool.query<{ onboarding_status: OnboardingStatus }>(
      `SELECT onboarding_status FROM specs WHERE id = $1`,
      [specId]
    );
    return res.rows[0]?.onboarding_status ?? null;
  } catch (err) {
    throw new DatabaseError('getOnboardingStatus failed', { cause: err });
  }
}

// Lock the spec row FOR UPDATE so the later UPDATE is serialized against a
// concurrent delete/state-change — a missing row is detected here, never as a
// silent 0-row UPDATE reported as success (CodeRabbit Major, #248).
async function lockSpecRow(client: PoolClient, specId: string): Promise<StatusRow | null> {
  const res = await client.query<StatusRow>(
    `SELECT onboarding_status, library_id FROM specs WHERE id = $1 FOR UPDATE`,
    [specId]
  );
  return res.rows[0] ?? null;
}

async function setOnboardingStatus(
  client: PoolClient,
  specId: string,
  status: OnboardingStatus
): Promise<void> {
  await client.query(`UPDATE specs SET onboarding_status = $2, updated_at = now() WHERE id = $1`, [
    specId,
    status,
  ]);
}

// Snapshot the rules that classify this spec's library into the library's OWN
// profile, so the next import self-classifies against them (#139 / ADR-022).
// INSERT-only: if the library already owns a profile (or a concurrent PUT just
// created one), the user's edit is left intact — never clobbered with built-in
// defaults (Codex P2, #248). Runs on the transaction client, atomic with the flip.
async function snapshotLibraryConvention(client: PoolClient, libraryId: string): Promise<void> {
  const resolved = await getConventionForLibrary(libraryId, client);
  if (!resolved) return; // no rules to snapshot (no built-in seeded) — flip only.
  await seedLibraryConventionIfAbsent(libraryId, resolved.name, resolved.rules, client);
}

async function runFinalize(client: PoolClient, specId: string): Promise<FinalizeOutcome> {
  const row = await lockSpecRow(client, specId);
  if (!row) return { status: 'not-found' };
  if (row.onboarding_status === 'active') return { status: 'already-active' };
  if (row.library_id) await snapshotLibraryConvention(client, row.library_id);
  await setOnboardingStatus(client, specId, 'active');
  return { status: 'finalized' };
}

async function runReopen(client: PoolClient, specId: string): Promise<ReopenOutcome> {
  const row = await lockSpecRow(client, specId);
  if (!row) return { status: 'not-found' };
  if (row.onboarding_status === 'review') return { status: 'already-review' };
  await setOnboardingStatus(client, specId, 'review');
  return { status: 'reopened' };
}

// Run a finalize/reopen body inside a single transaction so the FOR UPDATE lock
// holds across the read, the convention snapshot, and the flip. Early returns
// still COMMIT (they read nothing they must roll back, and releasing on a clean
// txn keeps the pool tidy); any error rolls back, best-effort.
async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}

// review → active (ADR-022 D6). A spec with no library just flips. Idempotent:
// finalizing an already-active spec is a no-op.
export async function finalizeOnboarding(specId: string): Promise<FinalizeOutcome> {
  try {
    return await inTransaction((client) => runFinalize(client, specId));
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('finalizeOnboarding failed', { cause: err });
  }
}

// active → review (ADR-022 D6). Purely informational; nothing gates on it (#139).
export async function reopenOnboarding(specId: string): Promise<ReopenOutcome> {
  try {
    return await inTransaction((client) => runReopen(client, specId));
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('reopenOnboarding failed', { cause: err });
  }
}
