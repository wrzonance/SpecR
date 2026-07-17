// Unit tests for tree.js's CSI-ordinal bookkeeping (#519 review finding on #300 WS3).
// Run: node --test examples/web_ui_demo/tree.test.mjs
// No jsdom in this repo (see editor-header-footer.test.mjs) — tree.js's DOM rendering
// stays untested by precedent (object-render.test.mjs: "renderObjectBlock itself is
// DOM-only and untested"). These exercise the two pure, exported ordinal-bookkeeping
// functions instead: consumesNumber (the predicate) and computeOrdinals (the actual
// numbered-outline sequence), so a future edit that silently drops object/objectText
// from the exclusion list — or otherwise breaks the resulting ordinal sequence —
// fails a test instead of only showing up as a shifted CSI number in a browser.
// Mirrors src/ast/labels.test.ts (the server-side twin of consumesNumber) and
// src/generator/markdown.test.ts's "#300: a root-level object does not shift PART
// numbering" invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumesNumber, computeOrdinals } from './js/tree.js';

const node = (type, vanish = false) => ({ type, meta: { vanish } });

// Ordinals consumesNumber actually assigned only past numbered siblings — filters
// out the placeholder ordinal an unconsumed node (note/vanish/object/objectText)
// receives, since renderPrNode never uses that value for those types (an `object`
// row renders via renderObjectBlock, which takes no index at all, and `objectText`
// renders an empty fragment). Asserting only on the numbered subsequence pins the
// visible invariant without over-specifying the unused placeholder values.
function numberedOrdinals(children) {
  const ordinals = computeOrdinals(children);
  return children
    .map((child, i) => (consumesNumber(child) ? ordinals[i] : null))
    .filter((ordinal) => ordinal !== null);
}

test('consumesNumber excludes object and objectText (#300) — never consume a CSI ordinal', () => {
  assert.equal(consumesNumber(node('object')), false);
  assert.equal(consumesNumber(node('objectText')), false);
});

test('consumesNumber still excludes the pre-existing non-numbered types', () => {
  assert.equal(consumesNumber(node('note')), false);
  assert.equal(consumesNumber(node('continuation')), false);
  assert.equal(consumesNumber(node('article', true)), false); // vanished
});

test('consumesNumber still consumes a number for ordinary structural types', () => {
  assert.equal(consumesNumber(node('part')), true);
  assert.equal(consumesNumber(node('article')), true);
  assert.equal(consumesNumber(node('pr1')), true);
});

test('computeOrdinals: an object/objectText pair between numbered pr1 siblings does not shift the ordinals of the siblings around it', () => {
  const children = [
    node('pr1'),
    node('object'),
    node('objectText'),
    node('pr1'),
    node('pr1'),
  ];
  // Sequential 0,1,2 — NOT 0,2,3 (which is what counting the object/objectText
  // pair as numbered siblings would produce).
  assert.deepEqual(numberedOrdinals(children), [0, 1, 2]);
});

test('computeOrdinals: notes, vanished siblings, and object/objectText together never shift numbered siblings (#122 regression, extended for #300)', () => {
  const children = [
    node('note'),
    node('pr1'),
    node('object'),
    node('objectText'),
    node('pr1', true), // vanished
    node('pr1'),
  ];
  assert.deepEqual(numberedOrdinals(children), [0, 1]);
});
