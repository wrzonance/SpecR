// Unit tests for the pure Compare filter + collapse helpers (#395). Run:
//   node --test examples/web_ui_demo/compare-filter.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's regression net for
// the Compare view modes: which rows a filter admits, chip counts (preferring the
// server summary), and the identical-run collapse that feeds the context expander.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARE_FILTERS,
  matchesFilter,
  filterCounts,
  resolveCounts,
  buildSegments,
} from './js/compare-filter.mjs';

const row = (state) => ({ state, cells: [] });

test('COMPARE_FILTERS declares all four chips in order', () => {
  assert.deepEqual(
    COMPARE_FILTERS.map((f) => f.id),
    ['all', 'changes', 'only-a', 'only-b']
  );
});

test('matchesFilter: all admits everything', () => {
  for (const state of ['identical', 'differing', 'only-a', 'only-b']) {
    assert.equal(matchesFilter(state, 'all'), true);
  }
});

test('matchesFilter: changes admits differing + one-sided, not identical', () => {
  assert.equal(matchesFilter('identical', 'changes'), false);
  assert.equal(matchesFilter('differing', 'changes'), true);
  assert.equal(matchesFilter('only-a', 'changes'), true);
  assert.equal(matchesFilter('only-b', 'changes'), true);
});

test('matchesFilter: only-a / only-b admit just their side', () => {
  assert.equal(matchesFilter('only-a', 'only-a'), true);
  assert.equal(matchesFilter('only-b', 'only-a'), false);
  assert.equal(matchesFilter('differing', 'only-a'), false);
  assert.equal(matchesFilter('only-b', 'only-b'), true);
  assert.equal(matchesFilter('only-a', 'only-b'), false);
});

test('filterCounts rolls the full matrix into chip counts', () => {
  const rows = [
    row('identical'),
    row('identical'),
    row('differing'),
    row('only-a'),
    row('only-b'),
    row('only-a'),
  ];
  assert.deepEqual(filterCounts(rows), { all: 6, changes: 4, 'only-a': 2, 'only-b': 1 });
});

test('resolveCounts falls back to computed counts when no summary', () => {
  const rows = [row('identical'), row('differing'), row('only-a')];
  assert.deepEqual(resolveCounts(rows, null), { all: 3, changes: 2, 'only-a': 1, 'only-b': 0 });
});

test('resolveCounts prefers the server summary for presence-based totals (ADR-053)', () => {
  const rows = [row('identical'), row('differing')]; // client changes = 1
  const summary = {
    rows: 340,
    differing: 12,
    columns: [
      { specId: 'a', onlyIn: 3 },
      { specId: 'b', onlyIn: 4 },
    ],
  };
  assert.deepEqual(resolveCounts(rows, summary), {
    all: 340, // presence/row-count total — server authoritative
    changes: 1, // normalization-dependent — always the client's rendered count, never summary.differing
    'only-a': 3,
    'only-b': 4,
  });
});

test('resolveCounts: changes badge matches the rows the filter renders, not summary.differing (#395 whitespace split-brain)', () => {
  // A whitespace-only delta is exact-differing to the server but normalizes to
  // identical client-side, so the Changes-only filter collapses it. Were the badge
  // sourced from summary.differing it would claim a change the filter never shows.
  const rows = [row('identical'), row('identical'), row('differing')]; // client renders 1 change
  const summary = { rows: 3, differing: 2 }; // server exact-text counts 2
  assert.equal(resolveCounts(rows, summary).changes, 1);
});

test('resolveCounts falls back per-field when summary is partial', () => {
  const rows = [row('identical'), row('only-a'), row('only-b')];
  const summary = { differing: 2 }; // only differing present; rows/columns absent
  assert.deepEqual(resolveCounts(rows, summary), {
    all: 3, // fell back to rows.length
    changes: 2, // from summary
    'only-a': 1, // fell back to computed
    'only-b': 1,
  });
});

test('buildSegments: all → every row is its own segment, key = matrix index', () => {
  const rows = [row('identical'), row('differing'), row('only-a')];
  const segments = buildSegments(rows, 'all');
  assert.equal(segments.length, 3);
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['row', 'row', 'row']
  );
  assert.deepEqual(
    segments.map((s) => s.key),
    [0, 1, 2]
  );
});

test('buildSegments: changes collapses identical runs into gaps, keeps changes as rows', () => {
  const rows = [
    row('identical'), // 0
    row('identical'), // 1  -> one gap {0}
    row('differing'), // 2
    row('identical'), // 3  -> gap {3}
    row('only-a'), // 4
    row('only-b'), // 5
    row('identical'), // 6  -> trailing gap {6}
  ];
  const segments = buildSegments(rows, 'changes');
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['gap', 'row', 'gap', 'row', 'row', 'gap']
  );
  assert.equal(segments[0].rows.length, 2);
  assert.equal(segments[0].key, 0);
  assert.equal(segments[1].row.state, 'differing');
  assert.equal(segments[1].key, 2);
  assert.equal(segments[2].rows.length, 1);
  assert.equal(segments[2].key, 3);
  assert.equal(segments[5].kind, 'gap');
  assert.equal(segments[5].key, 6);
});

test('buildSegments: only-a returns just the only-a subset with no gaps, stable keys', () => {
  const rows = [
    row('identical'), // 0
    row('only-a'), // 1
    row('differing'), // 2
    row('only-a'), // 3
    row('only-b'), // 4
  ];
  const segments = buildSegments(rows, 'only-a');
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['row', 'row']
  );
  assert.deepEqual(
    segments.map((s) => s.key),
    [1, 3]
  );
});

test('buildSegments: only-b subset', () => {
  const rows = [row('only-a'), row('only-b'), row('identical')];
  const segments = buildSegments(rows, 'only-b');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].key, 1);
  assert.equal(segments[0].row.state, 'only-b');
});
