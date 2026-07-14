import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── Invariant: src/ast/schemas.ts and its split-off spec-tree-schemas.ts stay
// under the repo's 400-line hard cap (eslint.config.js max-lines) ───────────
//
// #306's prerequisite refactor moves NodeTypeSchema..SpecTreeSchema out of
// schemas.ts (407 lines, already over the cap independent of #306) into a new
// spec-tree-schemas.ts, mirroring commit da3e149 (#474)'s style-schemas.ts
// split. A dedicated test (rather than relying on `pnpm lint` alone) pins the
// "split when exhausted" contract: if this ever regresses, the failure names
// the exact file and count instead of a generic eslint diagnostic.
//
// The count must mirror eslint's max-lines semantics — `{ skipBlankLines:
// true, skipComments: true }` — or the test would be stricter than the real
// constraint and could fail a file that `pnpm lint` accepts. So we blank out
// block comments (newlines preserved, so a wholly-commented line collapses to
// whitespace) and strip trailing `//` line comments, then count only lines
// with residual code. A line mixing code and a comment still counts, matching
// eslint, which only skips full-line comments.

const MAX_LINES = 400;

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

function lineCount(relativePath: string): number {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  const lines = blankBlockComments(readFileSync(path, 'utf8')).split('\n');
  // A trailing newline yields one extra empty element eslint also discards.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.filter(hasCode).length;
}

describe('src/ast/ schemas line budget (#306)', () => {
  it.each([
    ['./schemas.ts', './schemas.ts'],
    ['./spec-tree-schemas.ts', './spec-tree-schemas.ts'],
  ])('%s stays at or under the 400-line hard cap', (_name, relativePath) => {
    expect(lineCount(relativePath)).toBeLessThanOrEqual(MAX_LINES);
  });
});
