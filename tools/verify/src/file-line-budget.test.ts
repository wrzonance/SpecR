// Pins CLAUDE.md's tightened 400-line file cap (project override; the
// global default is 800) as a standalone, unit-testable invariant (#305
// task 1/7) — ESLint's max-lines rule already enforces this per file, but
// this gives the same check a synthetic-fixture-tested detector, same
// two-step pattern as import-boundary.test.ts: unit-test the counter
// against synthetic fixtures first, then scan the real tree with it.
//
// Motivating this task directly: the spike proved that appending client.ts's
// six new fixture-domain methods in place (rather than splitting shared
// internals into http.ts) pushes client.ts from 335 to ~427 lines — over
// budget. This test is the guard that would have caught that.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countNonBlankLines, MAX_SOURCE_FILE_LINES } from './file-line-budget.js';
import { listPackageSourceFiles } from './import-boundary.js';

describe('countNonBlankLines', () => {
  it('counts every non-empty line, ignoring blank lines', () => {
    expect(countNonBlankLines('a\n\nb\n   \nc')).toBe(3);
  });

  it('returns 0 for an empty or all-blank source', () => {
    expect(countNonBlankLines('')).toBe(0);
    expect(countNonBlankLines('\n\n   \n')).toBe(0);
  });

  it('counts a single line with no trailing newline', () => {
    expect(countNonBlankLines('only line')).toBe(1);
  });

  // Regression: ESLint's max-lines rule (eslint.config.js) is configured with
  // both skipBlankLines AND skipComments: true. A counter that only skips
  // blank lines is not equivalent — a file padded with comment-only lines
  // would be flagged here as over budget while `pnpm lint` stays green (or
  // vice versa, a comment-heavy file could pass here but fail lint). See
  // finding on file-line-budget.ts:18.
  it('does not count a line that is only a single-line comment', () => {
    expect(countNonBlankLines('const a = 1;\n// standalone comment\nconst b = 2;')).toBe(2);
  });

  it('does not count lines that are only a multi-line block comment', () => {
    const source = ['const a = 1;', '/*', ' * block comment', ' */', 'const b = 2;'].join('\n');
    expect(countNonBlankLines(source)).toBe(2);
  });

  it('still counts a line with code and a trailing line comment', () => {
    expect(countNonBlankLines('const a = 1; // trailing comment')).toBe(1);
  });

  it('still counts a line whose only content is a code+comment mix on the open/close of a block comment', () => {
    const source = ['const a = 1; /*', 'comment body', '*/ const b = 2;'].join('\n');
    expect(countNonBlankLines(source)).toBe(2);
  });

  it('does not mistake "//" inside a string literal for a line comment', () => {
    expect(countNonBlankLines("const url = 'http://localhost:3000';")).toBe(1);
  });

  it('does not mistake "/*" inside a string literal for a block comment', () => {
    expect(countNonBlankLines("const s = 'a /* not a comment */ b';\nconst t = 2;")).toBe(2);
  });
});

describe('tools/verify source tree stays within the 400-line file cap', () => {
  it(`no non-test .ts/.js file under src/ exceeds ${String(MAX_SOURCE_FILE_LINES)} non-blank lines`, () => {
    const packageRoot = resolve(import.meta.dirname, '..');
    const files = listPackageSourceFiles(resolve(packageRoot, 'src')).filter(
      (file) => !file.endsWith('.test.ts')
    );
    expect(files.length).toBeGreaterThan(0);

    const oversized = files
      .map((file) => ({ file, lineCount: countNonBlankLines(readFileSync(file, 'utf-8')) }))
      .filter(({ lineCount }) => lineCount > MAX_SOURCE_FILE_LINES);

    expect(oversized).toEqual([]);
  });
});
