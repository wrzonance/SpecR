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
 *
 * On 23503 vs 23001: Postgres 18 split what 16 reported as one code. 23503 now
 * means only "this row references a row that does not exist" (a create/update
 * with a bad FK) — which is what every current override map already uses it for
 * — so it keeps its 404. The delete-blocked-by-dependents direction moved to
 * 23001 and is a 409: the target exists, it just cannot be removed yet. See
 * docs/adr/084-postgres-18-restrict-violation.md.
 */
const PG_CODE_HTTP: Readonly<Record<string, { readonly status: number; readonly error: string }>> =
  {
    '23505': { status: 409, error: 'resource already exists' },
    '23503': { status: 404, error: 'referenced resource not found' },
    '23001': { status: 409, error: 'resource is still referenced and cannot be deleted' },
    '23514': { status: 422, error: 'value violates check constraint' },
  };

export function pgErrorToHttp(
  err: unknown,
  messages?: Readonly<Partial<Record<string, string>>>
): { readonly status: number; readonly error: string } | null {
  const code = getPgCode(err);
  if (code === undefined) return null;

  const mapped = PG_CODE_HTTP[code];
  if (mapped === undefined) return null;

  return { status: mapped.status, error: messages?.[code] ?? mapped.error };
}
