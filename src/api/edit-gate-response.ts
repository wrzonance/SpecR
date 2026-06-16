import { SpecNotFoundError, SpecWriteForbiddenError, StaleVersionError } from '../db/index.js';

/** Map an edit-gate error (ADR-018) to its HTTP response, or null if the error
 *  is not a gate error and should fall through to the handler's 500 path.
 *
 *  - StaleVersionError      → 409 with the current version, so the client can
 *                             refetch and retry without a second round-trip.
 *  - SpecWriteForbiddenError → 409 (archived spec, or upstream-locked).
 *  - SpecNotFoundError      → 404.
 *
 *  Shared by every content-write handler (paragraph PATCH, merge) so the
 *  precondition contract is identical across the write surface. */
export function gateErrorResponse(
  err: unknown
): { readonly status: number; readonly body: Record<string, unknown> } | null {
  if (err instanceof StaleVersionError) {
    return {
      status: 409,
      body: { success: false, error: err.message, currentVersion: err.currentVersion },
    };
  }
  if (err instanceof SpecWriteForbiddenError) {
    return { status: 409, body: { success: false, error: err.message } };
  }
  if (err instanceof SpecNotFoundError) {
    return { status: 404, body: { success: false, error: 'spec not found' } };
  }
  return null;
}
