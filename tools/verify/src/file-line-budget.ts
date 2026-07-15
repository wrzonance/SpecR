// Line-budget guard for tools/verify's own source tree (#305 task 1/7):
// CLAUDE.md's project override tightens the repo's file-size hard cap to
// 400 lines (not the global 800), and ESLint's max-lines rule already
// enforces it per file. This gives the same invariant a standalone,
// unit-testable detector — same pattern as import-boundary.ts's
// findOutOfBoundsSpecifiers — so a change that pushes a file over budget
// fails a named test, not just a lint error that's easy to miss in CI
// output.
//
// Motivating this module directly: the spike proved that appending
// client.ts's six new fixture-domain methods in place (rather than
// splitting shared internals into http.ts) pushes client.ts from 335 to
// ~427 lines — over budget. See file-line-budget.test.ts.

export const MAX_SOURCE_FILE_LINES = 400;

/** Count non-blank lines — mirrors ESLint's max-lines `skipBlankLines: true`. */
export function countNonBlankLines(source: string): number {
  return source.split('\n').filter((line) => line.trim() !== '').length;
}
