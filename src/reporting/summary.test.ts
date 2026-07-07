import { describe, it, expect } from 'vitest';
import { summarize, filterToDifferences } from './summary.js';
import type { BaselineLens, ComparisonCell, ComparisonMatrix } from './types.js';

const cell = (specId: string, text: string): ComparisonCell => ({
  present: true,
  specId,
  paragraphUuid: `${specId}-x`,
  text,
});
const absent: ComparisonCell = { present: false };

const matrix: ComparisonMatrix = {
  columns: [
    { specId: 'a', section: '07 21 00', title: 'T' },
    { specId: 'b', section: '07 21 00', title: 'T' },
  ],
  rows: [
    { originId: 'r1', cells: [cell('a', 'same'), cell('b', 'same')] }, // identical
    { originId: 'r2', cells: [cell('a', 'x'), cell('b', 'y')] }, // modified
    { originId: 'r3', cells: [cell('a', 'only-a'), absent] }, // only-in-a
    { originId: 'r4', cells: [absent, cell('b', 'only-b')] }, // only-in-b
  ],
};

describe('summarize', () => {
  it('rolls up overall + per-column counts consistent with the matrix', () => {
    const s = summarize(matrix);
    expect(s.rows).toBe(4);
    expect(s.aligned).toBe(2); // r1, r2 present in both
    expect(s.identical).toBe(1); // r1
    expect(s.differing).toBe(3); // r2, r3, r4
    expect(s.identical + s.differing).toBe(s.rows);
    expect(s.columns).toEqual([
      { specId: 'a', present: 3, onlyIn: 1 },
      { specId: 'b', present: 3, onlyIn: 1 },
    ]);
  });
});

describe('filterToDifferences', () => {
  it('keeps only non-identical rows and drops the identical one', () => {
    const { matrix: out } = filterToDifferences(matrix);
    expect(out.rows.map((r) => r.originId)).toEqual(['r2', 'r3', 'r4']);
    expect(out.columns).toEqual(matrix.columns);
  });

  it('filters the baseline lens rows to the same kept originIds', () => {
    const baseline: BaselineLens = {
      specId: 'a',
      rows: matrix.rows.map((r) => ({ originId: r.originId, states: ['baseline', 'unchanged'] })),
    };
    const { baseline: out } = filterToDifferences(matrix, baseline);
    expect(out?.rows.map((r) => r.originId)).toEqual(['r2', 'r3', 'r4']);
  });
});
