import { describe, it, expect } from 'vitest';
import { DatabaseError } from '../db/errors.js';
import { getPgCode, isRestrictedDeleteViolation } from './pg-errors.js';

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
