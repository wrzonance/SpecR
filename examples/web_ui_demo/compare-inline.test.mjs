// Unit tests for the pure merged-redline token builder (#395). Run:
//   node --test examples/web_ui_demo/compare-inline.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's regression net for
// the Inline review mode: a differing pair folds into ONE del/ins/shared stream,
// one-sided rows are wholly struck/inserted, and whitespace is never del/ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTokens, buildInlineTokens } from './js/compare-inline.mjs';

const changed = (tokens, kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text.trim());
const present = (specId, text) => ({ present: true, specId, paragraphUuid: `${specId}-p`, text });
const absent = () => ({ present: false });

test('mergeTokens marks nothing changed for identical strings', () => {
  const tokens = mergeTokens('the quick brown fox', 'the quick brown fox');
  assert.ok(tokens.every((t) => t.kind === 'shared'));
});

test('mergeTokens folds a differing pair into del(A) / ins(B) / shared words', () => {
  const tokens = mergeTokens('4000 psi concrete', '3000 psi concrete');
  assert.deepEqual(changed(tokens, 'del'), ['4000']);
  assert.deepEqual(changed(tokens, 'ins'), ['3000']);
  assert.deepEqual(
    tokens.filter((t) => t.kind === 'shared' && t.text.trim() !== '').map((t) => t.text),
    ['psi', 'concrete']
  );
});

test('mergeTokens against empty A is all insertions', () => {
  const tokens = mergeTokens('', 'brand new clause');
  assert.equal(changed(tokens, 'del').length, 0);
  assert.deepEqual(changed(tokens, 'ins'), ['brand', 'new', 'clause']);
});

test('mergeTokens: whitespace tokens are NEVER marked changed (pinned #395)', () => {
  const tokens = mergeTokens('big red car', 'big blue car');
  // Some words differ (red vs blue); every whitespace-only token must stay shared.
  const whitespace = tokens.filter((t) => t.text.trim() === '');
  assert.ok(whitespace.length > 0, 'expected some whitespace separators');
  assert.ok(whitespace.every((t) => t.kind === 'shared'));
  // And the diff itself is still correct.
  assert.deepEqual(changed(tokens, 'del'), ['red']);
  assert.deepEqual(changed(tokens, 'ins'), ['blue']);
});

test('mergeTokens joins tokens with shared single-space separators', () => {
  const tokens = mergeTokens('a b', 'a c');
  // Reconstructed text reads cleanly with single spaces.
  assert.equal(tokens.map((t) => t.text).join(''), 'a b c');
});

test('buildInlineTokens: differing row → merged redline', () => {
  const row = { state: 'differing', cells: [present('a', '4000 psi'), present('b', '3000 psi')] };
  const tokens = buildInlineTokens(row);
  assert.deepEqual(changed(tokens, 'del'), ['4000']);
  assert.deepEqual(changed(tokens, 'ins'), ['3000']);
});

test('buildInlineTokens: only-a row → single deletion of the whole text', () => {
  const row = { state: 'only-a', cells: [present('a', 'a clause only A has'), absent()] };
  assert.deepEqual(buildInlineTokens(row), [{ text: 'a clause only A has', kind: 'del' }]);
});

test('buildInlineTokens: only-b row → single insertion of the whole text', () => {
  const row = { state: 'only-b', cells: [absent(), present('b', 'a clause only B has')] };
  assert.deepEqual(buildInlineTokens(row), [{ text: 'a clause only B has', kind: 'ins' }]);
});

test('buildInlineTokens: identical row → single shared paragraph', () => {
  const row = { state: 'identical', cells: [present('a', 'same text'), present('b', 'same text')] };
  assert.deepEqual(buildInlineTokens(row), [{ text: 'same text', kind: 'shared' }]);
});
