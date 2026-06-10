import { DatabaseError } from '../db/index.js';

// Extracts the underlying PostgreSQL SQLSTATE code (e.g. '23503' FK violation,
// '23505' unique violation) from a DatabaseError that wraps a pg driver error.
// Returns undefined when the error is not a wrapped pg error.
export function getPgCode(err: unknown): string | undefined {
  if (!(err instanceof DatabaseError)) return undefined;
  const { cause } = err;
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
