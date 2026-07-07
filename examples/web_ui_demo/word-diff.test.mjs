// Unit tests for the pure word-level diff helper (#385). Run with:
//   node --test examples/web_ui_demo/word-diff.test.mjs
// These do NOT run in CI (examples/ is outside the vitest projects) — they are
// the demo's own regression net for the Compare view's diff highlighting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffWords } from './js/word-diff.mjs';

test('diffWords marks nothing changed for identical strings', () => {
  const { a, b } = diffWords('the quick brown fox', 'the quick brown fox');
  assert.ok(a.every((t) => !t.changed));
  assert.ok(b.every((t) => !t.changed));
});

test('diffWords round-trips the original text', () => {
  const inputA = 'Concrete shall be 4000 psi.';
  const inputB = 'Concrete shall be 3000 psi minimum.';
  const { a, b } = diffWords(inputA, inputB);
  assert.equal(a.map((t) => t.text).join(''), inputA);
  assert.equal(b.map((t) => t.text).join(''), inputB);
});

test('diffWords flags only the differing words', () => {
  const { a, b } = diffWords('4000 psi concrete', '3000 psi concrete');
  const changedA = a.filter((t) => t.changed).map((t) => t.text.trim());
  const changedB = b.filter((t) => t.changed).map((t) => t.text.trim());
  assert.deepEqual(changedA, ['4000']);
  assert.deepEqual(changedB, ['3000']);
});

test('diffWords treats empty input as all-changed against non-empty', () => {
  const { a, b } = diffWords('', 'new text');
  assert.equal(a.length, 0);
  assert.ok(b.some((t) => t.changed && t.text.trim() !== ''));
});
