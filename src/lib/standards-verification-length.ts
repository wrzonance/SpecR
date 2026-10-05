/**
 * Shared UNICODE CODE POINT bounds for `StandardVerificationBody` fields
 * (#642, ADR-091). Lives in `lib/` (not `api/`) because it is imported by
 * both `src/api/standards.ts` (`VerificationBodySchema`, the REST body) and
 * `src/mcp/standards-handlers.ts` (`RecordStandardVerificationShape`, which
 * does not reuse the REST validator — it re-declares its own bound). One
 * set of constants, two surfaces, no drift.
 */
export const MAX_CURRENT_VERSION_LENGTH = 200;
// The registry KEY (#692): the `{orgCode}/{standardCode}` path segments on REST
// and the same-named MCP tool inputs. Sized well past any real designation
// (the longest org code in the wild is a handful of letters; a standard code
// like "A653/A653M" is ~10) so the bound only ever refuses abuse.
export const MAX_ORG_CODE_LENGTH = 50;
export const MAX_STANDARD_CODE_LENGTH = 200;
export const MAX_SOURCE_URL_LENGTH = 2000;
export const MAX_TITLE_LENGTH = 500;
export const MAX_NOTES_LENGTH = 5000;
