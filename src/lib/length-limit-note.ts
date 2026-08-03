/**
 * Canonical prose appended to every `openapi.yaml` field description that
 * pairs a Zod `.max(n)` / `.check(z.maxLength(n))` with a JSON Schema
 * `maxLength: n` (#626, ADR-086).
 *
 * Zod's length checks delegate to JavaScript `String.prototype.length`
 * (UTF-16 code units); JSON Schema's `maxLength` keyword is defined in
 * Unicode code points. For any character outside the Basic Multilingual
 * Plane the two counts diverge by up to 2x. Rather than silently document
 * this divergence in ad-hoc, drifting prose per site, every affected field
 * shares this one exported string, and a single test
 * (`src/api/length-limit-unit-convention.test.ts`) asserts it appears
 * verbatim in each site's `openapi.yaml` description — so an edit to the
 * wording here surfaces as one failing diff instead of silent drift between
 * the constant and the spec.
 */
export const UTF16_LENGTH_LIMIT_NOTE =
  'This limit is counted in UTF-16 code units (JavaScript string length), ' +
  'not Unicode code points — characters outside the Basic Multilingual ' +
  'Plane (e.g. emoji) count as 2. See ADR-086.';
