// Unit tests for the pure header/footer scope-resolution helpers (#477). Run:
//   node --test examples/web_ui_demo/header-footer-resolve.test.mjs
// Outside CI (examples/ is not a vitest project) — the demo's own regression
// net for "who won" scope resolution shown in the Effective Resolution panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winningScope, scopeLabel } from './js/header-footer-resolve.mjs';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// Mirrors src/db/queries/header-footer.ts's HeaderFooterScope union — the id
// field name that goes with each `kind`.
const ID_FIELD_BY_KIND = {
  client: 'clientLibraryId',
  project: 'projectId',
  package: 'packageId',
  revision: 'revisionId',
};

// --- winningScope: coarse layers.at(-1)?.scope ?? null, never a per-key merge

test('winningScope: empty layers array is null (no override configured anywhere)', () => {
  assert.equal(winningScope([]), null);
});

test('winningScope: a single layer wins outright', () => {
  const layers = deepFreeze([{ scope: { kind: 'client', clientLibraryId: 'lib-1' }, config: {} }]);
  assert.deepEqual(winningScope(layers), { kind: 'client', clientLibraryId: 'lib-1' });
});

test('winningScope: with multiple layers, the LAST layer wins — not the first, not a merge', () => {
  const layers = deepFreeze([
    { scope: { kind: 'client', clientLibraryId: 'lib-1' }, config: {} },
    { scope: { kind: 'project', projectId: 'proj-1' }, config: {} },
    { scope: { kind: 'package', packageId: 'pkg-1' }, config: {} },
  ]);
  assert.deepEqual(winningScope(layers), { kind: 'package', packageId: 'pkg-1' });
});

test('winningScope: all 4 scope kinds round-trip through the "last wins" read', () => {
  for (const [kind, idField] of Object.entries(ID_FIELD_BY_KIND)) {
    const scope = { kind, [idField]: `${kind}-id` };
    const layers = deepFreeze([{ scope, config: {} }]);
    assert.deepEqual(winningScope(layers), scope);
  }
});

test('winningScope tolerates a null/undefined/non-array layers without throwing', () => {
  assert.doesNotThrow(() => winningScope(undefined));
  assert.doesNotThrow(() => winningScope(null));
  assert.equal(winningScope(undefined), null);
  assert.equal(winningScope(null), null);
  assert.equal(winningScope('not-an-array'), null);
});

test('winningScope does not mutate its input', () => {
  const layers = deepFreeze([{ scope: { kind: 'project', projectId: 'p' }, config: {} }]);
  assert.doesNotThrow(() => winningScope(layers));
});

// --- scopeLabel: exhaustive over the 4 HeaderFooterScope kinds + null -----

test('scopeLabel(null): "No override configured" for the empty-layers case', () => {
  assert.equal(scopeLabel(null), 'No override configured');
});

for (const [kind, expected] of [
  ['client', 'Client library'],
  ['project', 'Project'],
  ['package', 'Package'],
  ['revision', 'Revision'],
]) {
  test(`scopeLabel: '${kind}' scope labels as '${expected}'`, () => {
    const idField = ID_FIELD_BY_KIND[kind];
    assert.equal(scopeLabel({ kind, [idField]: 'x' }), expected);
  });
}

test('scopeLabel throws (fails loud) on an unrecognized scope kind rather than a blank label', () => {
  assert.throws(() => scopeLabel({ kind: 'division', divisionId: 'x' }), /division/);
});

test('scopeLabel throws on undefined — only the explicit null case means "no override"', () => {
  assert.throws(() => scopeLabel(undefined));
});

test('scopeLabel throws on a scope object with no kind at all', () => {
  assert.throws(() => scopeLabel({}));
});
