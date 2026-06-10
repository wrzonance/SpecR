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
