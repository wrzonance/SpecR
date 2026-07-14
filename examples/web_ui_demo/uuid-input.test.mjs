// Runtime invariants for normalizeUuidInput (#481, follow-up on a review
// finding: app-header-footer.test.mjs previously pinned this pure function
// via a source-text regex against app.js's function body — brittle to any
// behavior-preserving reformatting. normalizeUuidInput has no DOM dependency
// (unlike the rest of app.js, which reads `document` at module scope and so
// cannot be imported by a plain Node test — see app-header-footer.test.mjs's
// header comment), so it moved to its own pure module
// (js/uuid-input.mjs) and is exercised here for real instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUuidInput } from './js/uuid-input.mjs';

test('normalizeUuidInput: trims surrounding whitespace', () => {
  assert.equal(
    normalizeUuidInput('  aaaaaaaa-0000-4000-8000-000000000001  '),
    'aaaaaaaa-0000-4000-8000-000000000001'
  );
});

test('normalizeUuidInput: empty string coerces to null, never a bare \'\'', () => {
  assert.equal(normalizeUuidInput(''), null);
});

test('normalizeUuidInput: whitespace-only input coerces to null', () => {
  assert.equal(normalizeUuidInput('   '), null);
});

test('normalizeUuidInput: a non-empty value passes through unchanged', () => {
  assert.equal(
    normalizeUuidInput('aaaaaaaa-0000-4000-8000-000000000001'),
    'aaaaaaaa-0000-4000-8000-000000000001'
  );
});
