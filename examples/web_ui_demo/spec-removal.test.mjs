// Invariants for the project-copy removal conflict classifier (#413).
//
// DELETE /projects/:id/specs/:specId answers 409 for two very different
// reasons: the copy has project edits (retriable with ?force=true — the admin
// path) or it is pinned to a design package (force never helps). The demo must
// only offer the force retry for the first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRemovalConflict } from './js/spec-removal.mjs';

const err = (status, message) => Object.assign(new Error(message), { status });

test('classify: 409 with the force hint offers the admin force retry', () => {
  const conflict = err(409, 'section has project edits — repeat with ?force=true to delete them');
  assert.equal(classifyRemovalConflict(conflict), 'force-retry');
});

test('classify: 409 for a package-pinned section never offers force', () => {
  const conflict = err(409, 'section belongs to a design package — remove it from the package first');
  assert.equal(classifyRemovalConflict(conflict), 'in-package');
});

test('classify: non-409 errors are ordinary failures', () => {
  assert.equal(classifyRemovalConflict(err(404, 'spec not in project')), 'other');
  assert.equal(classifyRemovalConflict(err(500, 'boom')), 'other');
  assert.equal(classifyRemovalConflict(new Error('network down')), 'other');
});

test('classify: unknown 409 phrasing stays an ordinary failure (no blind force)', () => {
  assert.equal(classifyRemovalConflict(err(409, 'some future conflict')), 'other');
});
