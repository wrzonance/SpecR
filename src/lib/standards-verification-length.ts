/**
 * Shared UNICODE CODE POINT bounds for `StandardVerificationBody` fields
 * (#642, ADR-091). Lives in `lib/` (not `api/`) because it is imported by
 * both `src/api/standards.ts` (`VerificationBodySchema`, the REST body) and
 * `src/mcp/standards-handlers.ts` (`RecordStandardVerificationShape`, which
 * does not reuse the REST validator — it re-declares its own bound). One
 * set of constants, two surfaces, no drift.
 */
export const MAX_CURRENT_VERSION_LENGTH = 200;
export const MAX_SOURCE_URL_LENGTH = 2000;
export const MAX_TITLE_LENGTH = 500;
export const MAX_NOTES_LENGTH = 5000;
