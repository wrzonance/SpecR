// Unit tests for the pure Scoring report-model helpers (WS2, #424). Run:
//   node --test examples/web_ui_demo/scoring.test.mjs
// Outside CI (examples/ is not a vitest project) — mirrors compare-filter.test.mjs's
// style: model-level assertions only, no DOM. Exercises the filter/order logic
// scoring.js applies to a GET /specs/:id/hierarchy-report response.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCORING_FILTERS,
  confidenceBand,
  selectScoringRows,
  buildPositionMap,
} from './js/scoring-filter.mjs';
import { resolveLocateTarget, createRequestGuard } from './js/scoring.js';

const paragraph = (nodeId, confidence) => ({
  nodeId,
  nodeType: 'pr1',
  ilvl: 3,
  label: '1.1',
  preview: `paragraph ${nodeId}`,
  confidence,
  signalUsed: 1,
  agreed: [1],
  evidence: [],
});

test('SCORING_FILTERS declares all four controls in order', () => {
  assert.deepEqual(
    SCORING_FILTERS.map((f) => f.id),
    ['all', 'below-50', 'below-60', 'document-order']
  );
});

test('confidenceBand: <50% low, 50-60% mid, >=60% high', () => {
  assert.equal(confidenceBand(0.12), 'low');
  assert.equal(confidenceBand(0.49), 'low');
  assert.equal(confidenceBand(0.5), 'mid');
  assert.equal(confidenceBand(0.59), 'mid');
  assert.equal(confidenceBand(0.6), 'high');
  assert.equal(confidenceBand(0.97), 'high');
});

test('selectScoringRows: all returns every paragraph, worst-first, unchanged order', () => {
  const paragraphs = [paragraph('a', 0.1), paragraph('b', 0.4), paragraph('c', 0.9)];
  const rows = selectScoringRows(paragraphs, 'all');
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ['a', 'b', 'c']
  );
});

test('selectScoringRows: below-50 keeps only confidence < 0.5, worst-first', () => {
  const paragraphs = [
    paragraph('a', 0.1),
    paragraph('b', 0.49),
    paragraph('c', 0.5),
    paragraph('d', 0.9),
  ];
  const rows = selectScoringRows(paragraphs, 'below-50');
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ['a', 'b']
  );
});

test('selectScoringRows: below-60 keeps only confidence < 0.6, worst-first', () => {
  const paragraphs = [
    paragraph('a', 0.1),
    paragraph('b', 0.55),
    paragraph('c', 0.6),
    paragraph('d', 0.9),
  ];
  const rows = selectScoringRows(paragraphs, 'below-60');
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ['a', 'b']
  );
});

test('selectScoringRows: document-order reorders every paragraph by the supplied position map', () => {
  const paragraphs = [paragraph('a', 0.1), paragraph('b', 0.4), paragraph('c', 0.9)];
  // Worst-first order is a, b, c; document position is the reverse: c, b, a.
  const positionOf = new Map([
    ['c', 0],
    ['b', 1],
    ['a', 2],
  ]);
  const rows = selectScoringRows(paragraphs, 'document-order', positionOf);
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ['c', 'b', 'a']
  );
});

test('selectScoringRows: document-order sorts a paragraph missing from the position map last', () => {
  const paragraphs = [paragraph('a', 0.1), paragraph('b', 0.4)];
  const positionOf = new Map([['b', 0]]); // 'a' has no known position
  const rows = selectScoringRows(paragraphs, 'document-order', positionOf);
  assert.deepEqual(
    rows.map((r) => r.nodeId),
    ['b', 'a']
  );
});

test('buildPositionMap: depth-first document order, part -> article -> pr children', () => {
  const tree = {
    parts: [
      {
        id: 'part-1',
        children: [
          {
            id: 'art-1',
            children: [
              { id: 'pr-1', children: [] },
              { id: 'pr-2', children: [{ id: 'pr-2a', children: [] }] },
            ],
          },
        ],
      },
      { id: 'part-2', children: [] },
    ],
  };
  const positions = buildPositionMap(tree);
  assert.deepEqual(
    [...positions.entries()],
    [
      ['part-1', 0],
      ['art-1', 1],
      ['pr-1', 2],
      ['pr-2', 3],
      ['pr-2a', 4],
      ['part-2', 5],
    ]
  );
});

test('buildPositionMap: empty/missing tree yields an empty map', () => {
  assert.deepEqual(buildPositionMap({ parts: [] }), new Map());
  assert.deepEqual(buildPositionMap({}), new Map());
});

// Minimal sheet-like stub exercising resolveLocateTarget's 3-tier fallback
// (exact node -> sheet head -> none) without a real DOM. `nodesById` models
// the read-only render path (tree.js renderSpecSheet): only body paragraph/
// note rows carry [data-node-id] — part/article heading bars never do — so a
// missing id here is exactly the P2 bug's reproduction, not a test artifact.
function fakeSheet({ nodesById = {}, head = null } = {}) {
  return {
    querySelector(selector) {
      if (selector === '.sheet-head') return head;
      const match = /^\[data-node-id="([^"]+)"\]$/.exec(selector ?? '');
      return match ? (nodesById[match[1]] ?? null) : null;
    },
  };
}

test('resolveLocateTarget: exact node hit returns tier "exact"', () => {
  const node = { id: 'node-1' };
  const sheet = fakeSheet({ nodesById: { 'node-1': node }, head: { id: 'head' } });
  assert.deepEqual(resolveLocateTarget(sheet, 'node-1'), { node, tier: 'exact' });
});

test('resolveLocateTarget: heading row with no [data-node-id] anchor falls back to the sheet head', () => {
  const head = { id: 'head' };
  const sheet = fakeSheet({ nodesById: {}, head });
  // Mirrors a scored part/article row: nodeId is set on the row, but the
  // read-only sheet never stamped it on the heading bar, so the exact-node
  // query misses and the fallback must still resolve to something.
  assert.deepEqual(resolveLocateTarget(sheet, 'part-1'), { node: head, tier: 'head' });
});

test('resolveLocateTarget: no anchor and no sheet head resolves to tier "none"', () => {
  const sheet = fakeSheet({ nodesById: {}, head: null });
  assert.deepEqual(resolveLocateTarget(sheet, 'missing-node'), { node: null, tier: 'none' });
});

test('resolveLocateTarget: no sheet at all resolves to tier "none"', () => {
  assert.deepEqual(resolveLocateTarget(null, 'node-1'), { node: null, tier: 'none' });
});

test('resolveLocateTarget: a stray double-quote in the nodeId never builds an unsafe selector', () => {
  // attrSelector's quote guard: a malformed id must not blow up querySelector
  // or match unrelated content — it degrades to the same fallback as a miss.
  const head = { id: 'head' };
  const sheet = fakeSheet({ nodesById: {}, head });
  assert.deepEqual(resolveLocateTarget(sheet, 'weird"id'), { node: head, tier: 'head' });
});

test('createRequestGuard: next() issues increasing tokens, each current until superseded', () => {
  const guard = createRequestGuard();
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.next();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});

test('createRequestGuard: bump() invalidates an in-flight token without issuing a new one', () => {
  // Regression for the P2 clear-selection bug: a refresh that leaves nothing
  // selected must still invalidate whatever fetch is already in flight, even
  // though it issues no new request of its own.
  const guard = createRequestGuard();
  const inFlight = guard.next();
  assert.equal(guard.isCurrent(inFlight), true);
  guard.bump();
  assert.equal(guard.isCurrent(inFlight), false);
});

test('createRequestGuard: bump() after several next() calls still invalidates the latest token', () => {
  const guard = createRequestGuard();
  guard.next();
  guard.next();
  const latest = guard.next();
  assert.equal(guard.isCurrent(latest), true);
  guard.bump();
  assert.equal(guard.isCurrent(latest), false);
});
