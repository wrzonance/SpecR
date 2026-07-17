// Unit tests for the pure demo object-render helpers (#300 WS3, task 7/8). Run:
//   node --test examples/web_ui_demo/object-render.test.mjs
// Outside CI (examples/ is not a vitest project) — pins the "simple grid"
// detection + row-chunking invariants the read-only table/text-box view relies
// on. These mirror src/generator/markdown.ts's isSimpleGrid/chunkIntoRows (the
// demo cannot import the TS build — see tree.js's consumesNumber for the
// established precedent of mirroring generator logic client-side).
// renderObjectBlock itself is DOM-only and untested, matching this directory's
// precedent for DOM-touching code (e.g. render-markdown.mjs's renderMarkdownInto).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSimpleGridObject, chunkIntoRows } from './js/object-render.mjs';

const cell = (text) => ({ type: 'objectText', text, children: [], meta: {} });

test('isSimpleGridObject is true when rows*columns exactly matches the captured cell count', () => {
  const node = { type: 'object', children: [cell('a'), cell('b'), cell('c'), cell('d')] };
  const meta = { kind: 'table', rows: 2, columns: 2 };
  assert.equal(isSimpleGridObject(node, meta), true);
});

test('isSimpleGridObject is false on a merged or blank cell (count mismatch)', () => {
  // 3 captured cells can't fill a 2x2 grid cleanly — a merged or blank cell
  // ate one of the four positions (ADR-072: a blank cell is never captured).
  const node = { type: 'object', children: [cell('a'), cell('b'), cell('c')] };
  const meta = { kind: 'table', rows: 2, columns: 2 };
  assert.equal(isSimpleGridObject(node, meta), false);
});

test('isSimpleGridObject is false when rows/columns are absent (text box or unscored)', () => {
  const node = { type: 'object', children: [cell('a')] };
  assert.equal(isSimpleGridObject(node, { kind: 'textBox' }), false);
  assert.equal(isSimpleGridObject(node, undefined), false);
});

test('isSimpleGridObject tolerates a node with no children array', () => {
  assert.equal(isSimpleGridObject({}, { kind: 'table', rows: 1, columns: 1 }), false);
});

test('chunkIntoRows splits a flat cell list into columns-wide rows, last row short', () => {
  const cells = [cell('a'), cell('b'), cell('c'), cell('d'), cell('e')];
  const rows = chunkIntoRows(cells, 2);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.map((c) => c.text)),
    [['a', 'b'], ['c', 'd'], ['e']]
  );
});

test('chunkIntoRows returns no rows for an empty cell list', () => {
  assert.deepEqual(chunkIntoRows([], 3), []);
});
