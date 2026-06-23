import { pool, DatabaseError } from '../index.js';
import { getConventionForLibrary, upsertLibraryConvention } from './conventions.js';

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

// Snapshot the rules that classify this spec's library into the library's OWN
// convention profile, so the next import from this library self-classifies
// against them instead of falling back to the built-in default (#139 / ADR-022).
// getConventionForLibrary resolves "library-own OR built-in"; writing the result
// back under the library makes the library own a profile. Idempotent upsert.
async function snapshotLibraryConvention(libraryId: string): Promise<void> {
  const resolved = await getConventionForLibrary(libraryId);
  if (!resolved) return; // no rules to snapshot (no built-in seeded) — flip only.
  await upsertLibraryConvention(libraryId, resolved.name, resolved.rules);
}

// review → active (ADR-022 D6). A spec with no library (project working copy)
// just flips. Idempotent: finalizing an already-active spec is a no-op.
export async function finalizeOnboarding(specId: string): Promise<FinalizeOutcome> {
  try {
    const cur = await pool.query<StatusRow>(
      `SELECT onboarding_status, library_id FROM specs WHERE id = $1`,
      [specId]
    );
    const row = cur.rows[0];
    if (!row) return { status: 'not-found' };
    if (row.onboarding_status === 'active') return { status: 'already-active' };
    if (row.library_id) await snapshotLibraryConvention(row.library_id);
    await pool.query(
      `UPDATE specs SET onboarding_status = 'active', updated_at = now() WHERE id = $1`,
      [specId]
    );
    return { status: 'finalized' };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('finalizeOnboarding failed', { cause: err });
  }
}

// active → review (ADR-022 D6). Purely informational; nothing gates on it (#139).
export async function reopenOnboarding(specId: string): Promise<ReopenOutcome> {
  try {
    const cur = await pool.query<{ onboarding_status: OnboardingStatus }>(
      `SELECT onboarding_status FROM specs WHERE id = $1`,
      [specId]
    );
    const status = cur.rows[0]?.onboarding_status;
    if (status === undefined) return { status: 'not-found' };
    if (status === 'review') return { status: 'already-review' };
    await pool.query(
      `UPDATE specs SET onboarding_status = 'review', updated_at = now() WHERE id = $1`,
      [specId]
    );
    return { status: 'reopened' };
  } catch (err) {
    throw new DatabaseError('reopenOnboarding failed', { cause: err });
  }
}
