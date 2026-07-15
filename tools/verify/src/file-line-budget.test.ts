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
