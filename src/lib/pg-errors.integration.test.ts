import { describe, it, expect, afterEach } from 'vitest';
import { pool, DatabaseError } from '../db/index.js';
import { getPgCode, isRestrictedDeleteViolation, pgErrorToHttp } from './pg-errors.js';

// Pins the SQLSTATE contract this codebase's error mapping depends on, against
// the REAL server rather than a hand-built cause object — the unit tests in
// pg-errors.test.ts can only prove the predicate handles codes we already
// thought of.
//
// Why this exists (ADR-084): Postgres 16 reported BOTH foreign-key failure
// directions as 23503. Postgres 18 split them — a delete blocked by a dependent
// row became 23001 (restrict_violation), while 23503 kept the
// references-a-missing-row meaning. That silently degraded every RESTRICT-delete
// guard to an unmapped 500, and no test caught it because nothing asserted what
// the server actually emits.
//
// These tests are deliberately version-AGNOSTIC: they never assert a literal
// code. They assert that whatever this server emits, our helpers classify it
// correctly. So they keep passing on 16 and 18, and they fail loudly if a future
// major splits or renames these codes again.
const TABLES = `pgerr_child_restrict, pgerr_child_noaction, pgerr_parent`;

afterEach(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${TABLES}`);
});

async function setupFixture(): Promise<void> {
  await pool.query(`DROP TABLE IF EXISTS ${TABLES}`);
  await pool.query(`CREATE TABLE pgerr_parent (id int PRIMARY KEY)`);
  await pool.query(
    `CREATE TABLE pgerr_child_restrict (
       id int PRIMARY KEY,
       pid int REFERENCES pgerr_parent(id) ON DELETE RESTRICT
     )`
  );
  await pool.query(
    `CREATE TABLE pgerr_child_noaction (
       id int PRIMARY KEY,
       pid int REFERENCES pgerr_parent(id)
     )`
  );
  await pool.query(`INSERT INTO pgerr_parent VALUES (1), (2)`);
  await pool.query(`INSERT INTO pgerr_child_restrict VALUES (10, 1)`);
  await pool.query(`INSERT INTO pgerr_child_noaction VALUES (20, 2)`);
}

/** Run a statement expected to fail, and wrap the driver error the way the
 *  query layer does so getPgCode's single cause-hop finds the SQLSTATE. */
async function captureDbError(sql: string): Promise<DatabaseError> {
  try {
    await pool.query(sql);
  } catch (err) {
    return new DatabaseError('integration probe failed', { cause: err });
  }
  throw new Error(`expected the statement to fail, but it succeeded: ${sql}`);
}

describe('pg-errors against a real server (SQLSTATE contract)', () => {
  it('classifies a RESTRICT-blocked delete via isRestrictedDeleteViolation, whatever code the server uses', async () => {
    await setupFixture();
    const err = await captureDbError(`DELETE FROM pgerr_parent WHERE id = 1`);

    // The point of the test: no literal code assertion. PG<=16 emits 23503 here,
    // PG18 emits 23001, and the predicate must span both without being edited.
    expect(isRestrictedDeleteViolation(err)).toBe(true);
    expect(getPgCode(err)).toBeDefined();
  });

  it('gives a RESTRICT-blocked delete an HTTP mapping instead of falling through to a 500', async () => {
    await setupFixture();
    const err = await captureDbError(`DELETE FROM pgerr_parent WHERE id = 1`);

    // Regression: 'pg-errors: PG18 restrict_violation fell through pgErrorToHttp
    // to an unmapped 500'. A null here is the exact production symptom — callers
    // rethrow and the error middleware emits a generic 500.
    //
    // Only the EXISTENCE of a mapping is asserted, deliberately. The resulting
    // STATUS for this one scenario is version-dependent and cannot be otherwise:
    // on PG<=16 a RESTRICT-blocked delete arrives as 23503, which must map to 404
    // because that same code carries the far more common
    // references-a-missing-row meaning; on PG18 it arrives as its own 23001 and
    // maps to 409, which is the more accurate answer. Asserting 409 here would
    // pass on 18 and fail on 16 while pretending to be version-agnostic. The
    // exact 23001 → 409 pair is pinned in pg-errors.test.ts, which builds the
    // code directly and so is genuinely version-independent.
    const mapped = pgErrorToHttp(err);
    expect(mapped).not.toBeNull();
    expect([404, 409]).toContain(mapped?.status);
  });

  it('still maps a row referencing a missing row to 404 — the direction PG18 did NOT move', async () => {
    await setupFixture();
    const err = await captureDbError(`INSERT INTO pgerr_child_restrict VALUES (99, 12345)`);

    // This is what every existing override map means by 23503 ('library not
    // found', 'project not found', 'referenced scope not found'). If a future
    // version moved THIS direction too, those messages would silently stop
    // applying — so pin it.
    expect(pgErrorToHttp(err)).toEqual({
      status: 404,
      error: 'referenced resource not found',
    });
  });

  it('treats a NO ACTION delete the same as RESTRICT, so the guard is not silently narrower', async () => {
    await setupFixture();
    const err = await captureDbError(`DELETE FROM pgerr_parent WHERE id = 2`);

    // A foreign key with no ON DELETE clause defaults to NO ACTION, which on both
    // 16 and 18 raises the generic 23503. Asserted so that a future version
    // splitting NO ACTION off as well cannot slip past unnoticed.
    expect(isRestrictedDeleteViolation(err)).toBe(true);
  });
});
