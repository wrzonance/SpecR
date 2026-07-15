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

type CommentScanState = 'code' | 'lineComment' | 'blockComment' | 'string';

interface ScanCursor {
  readonly index: number;
  readonly output: string;
  readonly state: CommentScanState;
  readonly stringDelimiter: string;
}

const STRING_DELIMITERS = new Set(["'", '"', '`']);

/** Inside `//...`: a comment ends at (and re-emits) the newline that closes it. */
function stepLineComment(source: string, cursor: ScanCursor): ScanCursor {
  const char = source[cursor.index] ?? '';
  return char === '\n'
    ? { ...cursor, index: cursor.index + 1, output: cursor.output + char, state: 'code' }
    : { ...cursor, index: cursor.index + 1 };
}

/** Inside `/* ... *\/`: drop comment text but keep newlines so line counts stay aligned. */
function stepBlockComment(source: string, cursor: ScanCursor): ScanCursor {
  const char = source[cursor.index] ?? '';
  const next = source[cursor.index + 1] ?? '';
  if (char === '*' && next === '/') return { ...cursor, index: cursor.index + 2, state: 'code' };
  return char === '\n'
    ? { ...cursor, index: cursor.index + 1, output: cursor.output + char }
    : { ...cursor, index: cursor.index + 1 };
}

/** Inside a string/template literal: pass content through untouched so `//`/`/*` inside it is never mistaken for a comment. */
function stepString(source: string, cursor: ScanCursor): ScanCursor {
  const char = source[cursor.index] ?? '';
  const next = source[cursor.index + 1] ?? '';
  if (char === '\\')
    return { ...cursor, index: cursor.index + 2, output: cursor.output + char + next };
  const state = char === cursor.stringDelimiter ? 'code' : cursor.state;
  return { ...cursor, index: cursor.index + 1, output: cursor.output + char, state };
}

/** Outside any comment/string: watch for a comment or string literal opening. */
function stepCode(source: string, cursor: ScanCursor): ScanCursor {
  const char = source[cursor.index] ?? '';
  const next = source[cursor.index + 1] ?? '';
  if (char === '/' && next === '/')
    return { ...cursor, index: cursor.index + 2, state: 'lineComment' };
  if (char === '/' && next === '*')
    return { ...cursor, index: cursor.index + 2, state: 'blockComment' };
  if (STRING_DELIMITERS.has(char)) {
    return {
      ...cursor,
      index: cursor.index + 1,
      output: cursor.output + char,
      state: 'string',
      stringDelimiter: char,
    };
  }
  return { ...cursor, index: cursor.index + 1, output: cursor.output + char };
}

const STEP_BY_STATE: Record<CommentScanState, (source: string, cursor: ScanCursor) => ScanCursor> =
  {
    code: stepCode,
    lineComment: stepLineComment,
    blockComment: stepBlockComment,
    string: stepString,
  };

/**
 * Strip `//` line comments and `/* ... *\/` block comments from `source`,
 * leaving string/template contents untouched and newlines intact so the
 * result still splits into the same number of lines as the input. A line
 * whose only content was a comment collapses to an empty (or whitespace)
 * line, which countNonBlankLines then filters out — this is what makes it
 * mirror ESLint's `skipComments: true`, not just `skipBlankLines: true`.
 *
 * A line-oriented heuristic scoped to this codebase's own style, matching
 * import-boundary.ts's regex-based detector rather than a full JS/TS parser:
 * it does not track regex literals, so a `/` that opens a regex containing
 * `//` or `/*` could misparse. None of the source this scans today does that.
 */
function stripComments(source: string): string {
  let cursor: ScanCursor = { index: 0, output: '', state: 'code', stringDelimiter: '' };
  while (cursor.index < source.length) {
    cursor = STEP_BY_STATE[cursor.state](source, cursor);
  }
  return cursor.output;
}

/**
 * Count non-blank, non-comment-only lines — mirrors ESLint's max-lines
 * `skipBlankLines: true, skipComments: true` (eslint.config.js).
 */
export function countNonBlankLines(source: string): number {
  return stripComments(source)
    .split('\n')
    .filter((line) => line.trim() !== '').length;
}
