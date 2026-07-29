import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Test-only helper (#380): mirrors eslint's `max-lines` semantics
 * (`{ skipBlankLines: true, skipComments: true }`) so a passing assertion here
 * is never stricter than `pnpm lint`'s real constraint. Extracted out of
 * src/ast/schemas-line-budget.test.ts, src/parser/docx/line-budget.test.ts, and
 * src/api/router-header-footer.test.ts, which each carried an identical
 * copy — a fourth copy (src/db/index-line-budget.test.ts) crossed the DRY
 * threshold (code.md: extract at 3+ repeats). Those three keep their existing
 * inline copies; only new call sites use this module.
 */
export const MAX_LINES = 400;

// Linear indexOf scan (no backtracking regex): blank each /* */ span to spaces
// while keeping its newlines, so line-number alignment and blank detection hold.
function blankBlockComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('/*', i);
    if (open === -1) {
      out += source.slice(i);
      break;
    }
    const close = source.indexOf('*/', open + 2);
    const end = close === -1 ? source.length : close + 2;
    out += source.slice(i, open) + source.slice(open, end).replace(/[^\n]/g, ' ');
    i = end;
  }
  return out;
}

// A line counts unless it's blank or wholly a comment: drop the `//` line
// comment (indexOf, not regex) and check for leftover code. Block comments are
// already blanked out upstream, so this only has to handle line comments.
function hasCode(line: string): boolean {
  const slash = line.indexOf('//');
  const code = slash === -1 ? line : line.slice(0, slash);
  return code.trim() !== '';
}

/**
 * ESLint-counted line count for `relativePath`, resolved against the calling
 * test file's own `import.meta.url` (so relative paths in call sites read
 * naturally, exactly as they did in the pre-extraction inline copies).
 */
export function lineCount(callerUrl: string, relativePath: string): number {
  const path = fileURLToPath(new URL(relativePath, callerUrl));
  const lines = blankBlockComments(readFileSync(path, 'utf8')).split('\n');
  // A trailing newline yields one extra empty element eslint also discards.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.filter(hasCode).length;
}
