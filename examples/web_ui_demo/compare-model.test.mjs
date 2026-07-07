// Unit tests for the pure Compare view-model + feature detection (#385). Run:
//   node --test examples/web_ui_demo/compare-model.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's own regression net
// for mapping the grounded ComparisonReport (ADR-047) into a render-ready shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellState,
  buildCompareView,
  detectCompareFeatures,
  baselineStatesFor,
} from './js/compare-model.mjs';

const present = (specId, text) => ({ present: true, specId, paragraphUuid: `${specId}-p`, text });
const absent = () => ({ present: false });

test('cellState classifies identical, differing, and one-sided cells', () => {
  assert.equal(cellState(present('a', 'x'), present('b', 'x')), 'identical');
  assert.equal(cellState(present('a', 'x'), present('b', 'y')), 'differing');
  assert.equal(cellState(present('a', 'x'), absent()), 'only-a');
  assert.equal(cellState(absent(), present('b', 'y')), 'only-b');
  assert.equal(cellState(absent(), absent()), 'absent');
});

test('cellState ignores whitespace-only differences', () => {
  assert.equal(cellState(present('a', 'x  y'), present('b', 'x y')), 'identical');
});

test('buildCompareView maps columns, rows, and per-row state', () => {
  const report = {
    columns: [
      { specId: 'a', section: '03 30 00', title: 'Cast-in-Place' },
      { specId: 'b', section: '03 30 00', title: 'Concrete' },
    ],
    rows: [
      { originId: 'o1', cells: [present('a', 'same'), present('b', 'same')] },
      { originId: 'o2', cells: [present('a', '4000 psi'), present('b', '3000 psi')] },
      { originId: 'o3', cells: [present('a', 'only a'), absent()] },
    ],
  };
  const view = buildCompareView(report);
  assert.equal(view.columns.length, 2);
  assert.deepEqual(
    view.rows.map((r) => r.state),
    ['identical', 'differing', 'only-a']
  );
  assert.equal(view.hasBaseline, false);
  assert.equal(view.rows[0].baselineStates, null);
});

test('buildCompareView surfaces the baseline lens states per row when present', () => {
  const report = {
    columns: [
      { specId: 'a', section: '03 30 00', title: 'A' },
      { specId: 'b', section: '03 30 00', title: 'B' },
    ],
    rows: [{ originId: 'o1', cells: [present('a', 'x'), present('b', 'y')] }],
    baseline: { specId: 'a', rows: [{ originId: 'o1', states: ['baseline', 'modified'] }] },
  };
  const view = buildCompareView(report);
  assert.equal(view.hasBaseline, true);
  assert.deepEqual(view.rows[0].baselineStates, ['baseline', 'modified']);
  assert.deepEqual(baselineStatesFor(report, 'o1'), ['baseline', 'modified']);
  assert.equal(baselineStatesFor(report, 'missing'), null);
});

test('detectCompareFeatures reads additive #384 fields by presence', () => {
  assert.deepEqual(detectCompareFeatures({ columns: [], rows: [] }), {
    summary: false,
    alignedBy: false,
  });
  assert.deepEqual(
    detectCompareFeatures({ columns: [], rows: [], summary: { differing: 2 }, alignedBy: 'origin' }),
    { summary: true, alignedBy: true }
  );
});

test('buildCompareView tolerates a missing/empty report', () => {
  const view = buildCompareView(null);
  assert.deepEqual(view.columns, []);
  assert.deepEqual(view.rows, []);
  assert.equal(view.hasBaseline, false);
});
