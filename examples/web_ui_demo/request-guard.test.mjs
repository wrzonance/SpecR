// Unit tests for the shared monotonic stale-response guard. Run:
//   node --test examples/web_ui_demo/request-guard.test.mjs
// Outside CI (examples/ is not a vitest project) — moved out of
// scoring.test.mjs when header-footer-editor.js/header-footer.js (#477)
// became this primitive's second and third consumers (see js/request-guard.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestGuard } from './js/request-guard.mjs';

test('createRequestGuard: next() issues increasing tokens, each current until superseded', () => {
  const guard = createRequestGuard();
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.next();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
});

test('createRequestGuard: bump() invalidates an in-flight token without issuing a new one', () => {
  // Regression for the P2 clear-selection bug (scoring.js's loadSelected): a
  // refresh that leaves nothing selected must still invalidate whatever
  // fetch is already in flight, even though it issues no new request of its
  // own.
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

