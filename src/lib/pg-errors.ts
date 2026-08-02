import { DatabaseError } from '../db/index.js';

/**
 * Walk the error cause chain looking for a PostgreSQL error code.
 * Returns the code string (e.g. '23505') or undefined if not found.
 */
export function getPgCode(err: unknown): string | undefined {
  if (!(err instanceof DatabaseError)) return undefined;
  const { cause } = err;
  if (cause !== null && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * True iff err is blocked by an ON DELETE RESTRICT foreign key — i.e. another
 * row still references the one being deleted. Postgres <=16 reports this as
 * the generic foreign_key_violation (23503); Postgres 18 disambiguates the
 * RESTRICT-specific case as restrict_violation (23001) per the SQL standard,
 * reserving 23503 for the insert/update-references-missing-row direction.
 * Callers that guard a DELETE against a RESTRICT-protected parent must accept
 * BOTH codes to work on Postgres 16 and 18 alike.
 */
export function isRestrictedDeleteViolation(err: unknown): boolean {
  const code = getPgCode(err);
  return code === '23503' || code === '23001';
}

/**
 * Map a pg error code to an HTTP status + message pair, or null if unrecognised.
 * Callers may pass a `messages` override to customise the human-readable string
 * for a specific code without duplicating the code-lookup logic.
 */
export function pgErrorToHttp(
  err: unknown,
  messages?: Readonly<Partial<Record<string, string>>>
): { readonly status: number; readonly error: string } | null {
  const code = getPgCode(err);
  if (!code) return null;

  const override = messages?.[code];

  switch (code) {
    case '23505':
      return { status: 409, error: override ?? 'resource already exists' };
    case '23503':
      return { status: 404, error: override ?? 'referenced resource not found' };
    case '23514':
      return { status: 422, error: override ?? 'value violates check constraint' };
    default:
      return null;
  }
}
