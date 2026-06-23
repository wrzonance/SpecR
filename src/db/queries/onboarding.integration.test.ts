import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { getOnboardingStatus, finalizeOnboarding, reopenOnboarding } from './onboarding.js';
import { createLibrary } from './libraries.js';
import { getConventionForLibrary, upsertLibraryConvention } from './conventions.js';

const MISSING_ID = '00000000-0000-0000-0000-000000000000';

let sectionCounter = 0;

// Unique section per spec so two specs can share a library without colliding on
// the (section, source, library_id) unique constraint.
async function makeSpec(libraryId: string, status: 'review' | 'active'): Promise<string> {
  sectionCounter += 1;
  const section = `09 91 ${String(sectionCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, onboarding_status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [section, 't', 'docx', libraryId, status]
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('no spec id');
  return id;
}

afterEach(async () => {
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fin-%')`
  );
  await pool.query(
    `DELETE FROM editing_conventions WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-fin-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-fin-%'`);
});

describe('onboarding status transitions', () => {
  it('getOnboardingStatus returns the stored status, null for missing', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-get', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    expect(await getOnboardingStatus(specId)).toBe('review');
    expect(await getOnboardingStatus(MISSING_ID)).toBeNull();
  });

  it('finalize flips review→active and snapshots the library convention profile', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-snap', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    // Before: the library has no own profile (resolves to the built-in default).
    const beforeOwn = await pool.query(`SELECT 1 FROM editing_conventions WHERE library_id = $1`, [
      lib.id,
    ]);
    expect(beforeOwn.rowCount).toBe(0);

    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('finalized');
    expect(await getOnboardingStatus(specId)).toBe('active');

    // After: the library now OWNS a convention profile (so future imports self-classify).
    const afterOwn = await pool.query(`SELECT 1 FROM editing_conventions WHERE library_id = $1`, [
      lib.id,
    ]);
    expect(afterOwn.rowCount).toBe(1);
    const resolved = await getConventionForLibrary(lib.id);
    expect(resolved?.libraryId).toBe(lib.id);
  });

  it('finalize: insert-only snapshot — existing library profile is left untouched', async () => {
    // Finding 2 regression (Codex P2): a library that ALREADY owns a convention
    // profile must keep its rules AND not be rewritten at all through finalize —
    // the snapshot is seed-only (ON CONFLICT DO NOTHING), never a DO UPDATE. We
    // assert updated_at is byte-for-byte unchanged: a REPLACE-style upsert would
    // bump it (and, under the documented race, clobber the user's rules).
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-keep', owner: 'o' });
    const distinctive = { noteBanners: ['^FIRM-SPECIFIC BANNER$'] };
    await upsertLibraryConvention(lib.id, 'Firm Profile', distinctive);
    const before = await pool.query<{ updated_at: Date; rules: unknown }>(
      `SELECT updated_at, rules FROM editing_conventions WHERE library_id = $1`,
      [lib.id]
    );
    const specId = await makeSpec(lib.id, 'review');

    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('finalized');

    // The library still owns exactly one profile, untouched: same updated_at,
    // same rules, same name.
    const after = await pool.query<{ updated_at: Date; rules: unknown }>(
      `SELECT updated_at, rules FROM editing_conventions WHERE library_id = $1`,
      [lib.id]
    );
    expect(after.rowCount).toBe(1);
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
    const resolved = await getConventionForLibrary(lib.id);
    expect(resolved?.name).toBe('Firm Profile');
    expect(resolved?.rules.noteBanners).toEqual(['^FIRM-SPECIFIC BANNER$']);
  });

  it('finalize: snapshot-creates — a library with no profile gains one from the resolved rules', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-seed', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    const builtIn = await getConventionForLibrary(lib.id); // resolves to built-in default
    expect(builtIn?.libraryId).toBeNull();

    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('finalized');

    const resolved = await getConventionForLibrary(lib.id);
    expect(resolved?.libraryId).toBe(lib.id);
    expect(resolved?.rules).toEqual(builtIn?.rules);
  });

  it('finalize: delete-then-finalize returns not-found, never a false success', async () => {
    // Finding 1 regression (CodeRabbit Major): the SELECT … FOR UPDATE + UPDATE
    // run in one transaction, so a spec deleted before finalize cannot yield a
    // 0-row UPDATE reported as 'finalized'.
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-del', owner: 'o' });
    const specId = await makeSpec(lib.id, 'review');
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
    expect((await finalizeOnboarding(specId)).status).toBe('not-found');
    expect((await reopenOnboarding(specId)).status).toBe('not-found');
  });

  it('finalize on an already-active spec is an idempotent no-op', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-idem', owner: 'o' });
    const specId = await makeSpec(lib.id, 'active');
    const out = await finalizeOnboarding(specId);
    expect(out.status).toBe('already-active');
    expect(await getOnboardingStatus(specId)).toBe('active');
  });

  it('finalize on a missing spec returns not-found', async () => {
    const out = await finalizeOnboarding(MISSING_ID);
    expect(out.status).toBe('not-found');
  });

  it('reopen flips active→review; already-review and not-found are reported', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-fin-reopen', owner: 'o' });
    const activeId = await makeSpec(lib.id, 'active');
    expect((await reopenOnboarding(activeId)).status).toBe('reopened');
    expect(await getOnboardingStatus(activeId)).toBe('review');

    const reviewId = await makeSpec(lib.id, 'review');
    expect((await reopenOnboarding(reviewId)).status).toBe('already-review');
    expect((await reopenOnboarding(MISSING_ID)).status).toBe('not-found');
  });
});
