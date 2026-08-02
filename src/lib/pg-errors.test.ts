import { describe, it, expect } from 'vitest';
import { DatabaseError } from '../db/errors.js';
import { getPgCode, isRestrictedDeleteViolation, pgErrorToHttp } from './pg-errors.js';

// Postgres <=16 reports an ON DELETE RESTRICT rejection as the generic
// foreign_key_violation (23503); Postgres 18 disambiguates it as the
// SQL-standard restrict_violation (23001), reserving 23503 for the
// insert/update-references-missing-row direction. See docs/adr/084-*.md.
const withPgCode = (code: string): DatabaseError =>
  new DatabaseError('db operation failed', { cause: { code } });

describe('getPgCode', () => {
  it('resolves the SQLSTATE from exactly one cause-hop on a DatabaseError', () => {
    expect(getPgCode(withPgCode('23503'))).toBe('23503');
    expect(getPgCode(withPgCode('23001'))).toBe('23001');
  });

  it('returns undefined for non-DatabaseError values', () => {
    expect(getPgCode(new Error('plain error'))).toBeUndefined();
    expect(getPgCode('not an error')).toBeUndefined();
    expect(getPgCode(undefined)).toBeUndefined();
  });
});

describe('isRestrictedDeleteViolation', () => {
  it('returns true for the pre-PG18 generic foreign_key_violation code (23503)', () => {
    expect(isRestrictedDeleteViolation(withPgCode('23503'))).toBe(true);
  });

  it('returns true for the PG18 restrict_violation code (23001)', () => {
    expect(isRestrictedDeleteViolation(withPgCode('23001'))).toBe(true);
  });

  it('returns false for an unrelated pg error code', () => {
    expect(isRestrictedDeleteViolation(withPgCode('23505'))).toBe(false);
  });

  it('returns false for non-pg errors, including undefined', () => {
    expect(isRestrictedDeleteViolation(new Error('plain error'))).toBe(false);
    expect(isRestrictedDeleteViolation(undefined)).toBe(false);
  });
});

describe('pgErrorToHttp', () => {
  // Regression: 'pg-errors: PG18 restrict_violation (23001) fell through to a
  // generic 500'. Before this mapping existed, a DELETE blocked by an ON DELETE
  // RESTRICT foreign key returned 23001 on Postgres 18, hit the switch's
  // default, and surfaced as an unmapped 500 with no test asserting otherwise.
  it('maps the PG18 restrict_violation code (23001) to 409, not a fall-through null', () => {
    expect(pgErrorToHttp(withPgCode('23001'))).toEqual({
      status: 409,
      error: 'resource is still referenced and cannot be deleted',
    });
  });

  it('honours a caller message override for 23001', () => {
    expect(pgErrorToHttp(withPgCode('23001'), { '23001': 'client still has projects' })).toEqual({
      status: 409,
      error: 'client still has projects',
    });
  });

  // 23503 keeps its existing 404 meaning: on PG18 that code is now reserved for
  // the insert/update-references-a-missing-row direction, which is exactly what
  // every current override map ('library not found', 'project not found',
  // 'referenced scope not found') already means by it.
  it('leaves the 23503 → 404 mapping intact for the missing-referenced-row direction', () => {
    expect(pgErrorToHttp(withPgCode('23503'))).toEqual({
      status: 404,
      error: 'referenced resource not found',
    });
  });

  it('returns null for an unrecognised code and for a non-pg error', () => {
    expect(pgErrorToHttp(withPgCode('42P01'))).toBeNull();
    expect(pgErrorToHttp(new Error('plain error'))).toBeNull();
  });
});
