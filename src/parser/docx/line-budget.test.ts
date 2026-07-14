import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── Invariant: src/parser/docx/ files stay under the repo's 400-line hard cap
// (eslint.config.js max-lines) ─────────────────────────────────────────────
//
// #306 wires DOCX header/footer capture into index.ts, which is 392 lines
// before the feature lands — no headroom left. Two zero-behavior-change
// prerequisite extractions (source-detection.ts, then core-metadata.ts) carve
// out room before any feature code is added. This test pins the "split when
// exhausted" contract per-file, mirroring src/ast/schemas-line-budget.test.ts
// (#306's own precedent): if a file regresses over budget, the failure names
// the exact file and count instead of a generic eslint diagnostic surfacing
// only at `pnpm lint` time.
//
// The count mirrors eslint's max-lines semantics — `{ skipBlankLines: true,
// skipComments: true }` — so this test is never stricter than the real
// constraint. Block comments are blanked (newlines preserved) and trailing
// `//` line comments stripped before counting residual code lines.

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

describe('src/parser/docx/ line budget (#306)', () => {
  it.each([
    ['./index.ts', './index.ts'],
    ['./source-detection.ts', './source-detection.ts'],
    ['./core-metadata.ts', './core-metadata.ts'],
  ])('%s stays at or under the 400-line hard cap', (_name, relativePath) => {
    expect(lineCount(relativePath)).toBeLessThanOrEqual(MAX_LINES);
  });
});
