// Invariants for the project source-library ordering model (#413).
//
// The regression these pin: syncing client scope must NEVER silently
// reprioritize an explicitly ordered source chain — scoped additions append,
// they don't promote. And a shadowed upload must produce a visible notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSourcesWithScope,
  moveSource,
  resolutionNotice,
} from './js/source-order.mjs';

const COMPANY = 'lib-company';
const CLIENT_A = 'lib-client-a';
const CLIENT_B = 'lib-client-b';

const src = (libraryId, tier) => ({ libraryId, tier });

test('merge: preserves explicit order when scope is unchanged', () => {
  const current = [src(COMPANY, 'company'), src(CLIENT_A, 'client')];
  const merged = mergeSourcesWithScope(current, [CLIENT_A], COMPANY);
  assert.deepEqual(merged, [COMPANY, CLIENT_A]);
});

test('merge: newly scoped client APPENDS — never outranks existing sources', () => {
  const current = [src(COMPANY, 'company')];
  const merged = mergeSourcesWithScope(current, [CLIENT_A], COMPANY);
  assert.deepEqual(merged, [COMPANY, CLIENT_A]);
});

test('merge: descoped client is removed, remaining order intact', () => {
  const current = [src(CLIENT_A, 'client'), src(COMPANY, 'company'), src(CLIENT_B, 'client')];
  const merged = mergeSourcesWithScope(current, [CLIENT_B], COMPANY);
  assert.deepEqual(merged, [COMPANY, CLIENT_B]);
});

test('merge: company master appended when missing, never duplicated', () => {
  assert.deepEqual(mergeSourcesWithScope([], [CLIENT_A], COMPANY), [CLIENT_A, COMPANY]);
  const current = [src(COMPANY, 'company')];
  assert.deepEqual(mergeSourcesWithScope(current, [], COMPANY), [COMPANY]);
});

test('merge: tolerates a null company id (no company master yet)', () => {
  assert.deepEqual(mergeSourcesWithScope([], [CLIENT_A], null), [CLIENT_A]);
});

test('merge: does not mutate its inputs', () => {
  const current = [src(CLIENT_A, 'client')];
  const scoped = [CLIENT_A];
  mergeSourcesWithScope(current, scoped, COMPANY);
  assert.deepEqual(current, [src(CLIENT_A, 'client')]);
  assert.deepEqual(scoped, [CLIENT_A]);
});

test('moveSource: swaps with its neighbor and returns a new array', () => {
  const ids = [COMPANY, CLIENT_A, CLIENT_B];
  const up = moveSource(ids, CLIENT_B, -1);
  assert.deepEqual(up, [COMPANY, CLIENT_B, CLIENT_A]);
  assert.deepEqual(ids, [COMPANY, CLIENT_A, CLIENT_B]);
  const down = moveSource(ids, COMPANY, 1);
  assert.deepEqual(down, [CLIENT_A, COMPANY, CLIENT_B]);
});

test('moveSource: clamps at the edges and ignores unknown ids', () => {
  const ids = [COMPANY, CLIENT_A];
  assert.deepEqual(moveSource(ids, COMPANY, -1), ids);
  assert.deepEqual(moveSource(ids, CLIENT_A, 1), ids);
  assert.deepEqual(moveSource(ids, 'lib-unknown', 1), ids);
});

test('notice: warns when the uploaded library lost resolution to a higher-priority source', () => {
  const result = {
    source: { libraryId: CLIENT_A, name: 'ABC Fab' },
    shadowed: [{ libraryId: COMPANY, name: 'Default Company Master' }],
  };
  const notice = resolutionNotice(result, COMPANY);
  assert.equal(notice.kind, 'warn');
  assert.match(notice.message, /ABC Fab/);
  assert.match(notice.message, /shadow/i);
});

test('notice: reports shadowed sources even without an expected library', () => {
  const result = {
    source: { libraryId: COMPANY, name: 'Default Company Master' },
    shadowed: [{ libraryId: CLIENT_A, name: 'ABC Fab' }],
  };
  const notice = resolutionNotice(result, null);
  assert.equal(notice.kind, 'info');
  assert.match(notice.message, /ABC Fab/);
});

test('notice: silent when resolution matches the expected library and nothing is shadowed', () => {
  const result = { source: { libraryId: COMPANY, name: 'Default Company Master' } };
  assert.equal(resolutionNotice(result, COMPANY), null);
  assert.equal(resolutionNotice(result, null), null);
});
