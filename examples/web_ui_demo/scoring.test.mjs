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
