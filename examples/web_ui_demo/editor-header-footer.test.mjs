// Unit tests for editor.js's header/footer inspector call site (#477). Run:
//   node --test examples/web_ui_demo/editor-header-footer.test.mjs
// No jsdom in this repo — initEditor() itself is DOM-heavy (document.getElementById,
// tree.js's renderSpecSheet) and untested directly, same split as
// header-footer.js/header-footer-editor.js elsewhere in this demo. The one
// piece of real wiring logic worth pinning in isolation is
// appendHeaderFooterSummary — editor.js's exported call site for
// header-footer.js's ctx.mountHeaderFooterInspector, extracted specifically
// so this boundary is testable without the rest of the module.
//
// Pins two invariants from the design (mirrors header-footer.test.mjs's own
// invariants 1 and 3, exercised here through editor.js's side of the wire):
//   1. mountHeaderFooterInspector is only ever APPENDED into via editor.js's
//      call site — never used to clear pre-existing inspector content
//      (CITES/CITED BY/EDITABILITY, painted earlier in renderInspector).
//   2. The callback fires only when there is a selected section to summarize
//      AND the optional callback was actually wired in — an editor with no
//      selection, or a build where app.js never wired header/footer support,
//      must never call it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendHeaderFooterSummary } from './js/editor.js';

// Same fake mount-point shape as header-footer.test.mjs's fakeContainer — no
// jsdom, so nothing here is a real Node. Tracks whether the container was
// ever CLEARED (replaceChildren) vs. only ever appended to.
function fakeContainer(initialChildren = []) {
  const children = [...initialChildren];
  let clearedCount = 0;
  return {
    get children() {
      return children;
    },
    get clearedCount() {
      return clearedCount;
    },
    appendChild(node) {
      children.push(node);
      return node;
    },
    replaceChildren(...nodes) {
      clearedCount += 1;
      children.length = 0;
      children.push(...nodes);
    },
  };
}

test('appendHeaderFooterSummary: calls ctx.mountHeaderFooterInspector exactly once with (inspector, spec.tree)', () => {
  const inspector = fakeContainer([{ id: 'cites' }, { id: 'cited-by' }]);
  const tree = { id: 'spec-1', section: '09 91 26' };
  const spec = { tree, references: [] };
  const calls = [];
  const ctx = { mountHeaderFooterInspector: (container, s) => calls.push([container, s]) };

  appendHeaderFooterSummary(inspector, spec, ctx);

  assert.equal(calls.length, 1, 'the callback is invoked exactly once');
  assert.equal(calls[0][0], inspector, 'the same inspector container is passed through, not a copy');
  assert.equal(calls[0][1], tree, 'spec.tree is passed — not the { tree, references } wrapper');
});

test('appendHeaderFooterSummary: never clears the inspector — content painted earlier by renderInspector survives', () => {
  const preexisting = [{ id: 'cites' }, { id: 'cited-by' }, { id: 'editability' }];
  const inspector = fakeContainer(preexisting);
  const spec = { tree: { id: 'spec-1', section: '09 91 26' } };
  // A well-behaved mountHeaderFooterInspector, exactly like header-footer.js's
  // real mountInspector: appends exactly one wrapper, nothing else.
  const ctx = {
    mountHeaderFooterInspector: (container) => {
      container.appendChild({ id: 'hf-wrapper' });
    },
  };

  appendHeaderFooterSummary(inspector, spec, ctx);

  assert.equal(inspector.clearedCount, 0, 'replaceChildren must never be called');
  assert.deepEqual(
    inspector.children.slice(0, 3),
    preexisting,
    'pre-existing inspector content (CITES/CITED BY/EDITABILITY) survives untouched'
  );
  assert.equal(inspector.children.length, 4, 'exactly one wrapper is appended');
});

test('appendHeaderFooterSummary: no-op when no section is selected (spec is null) — the callback never fires', () => {
  const inspector = fakeContainer();
  let called = false;
  const ctx = { mountHeaderFooterInspector: () => { called = true; } };

  appendHeaderFooterSummary(inspector, null, ctx);

  assert.equal(called, false, 'nothing to summarize with no selected section');
  assert.equal(inspector.children.length, 0);
});

test('appendHeaderFooterSummary: no-op, and never throws, when ctx.mountHeaderFooterInspector was not wired in', () => {
  const inspector = fakeContainer();
  const spec = { tree: { id: 'spec-1' } };

  assert.doesNotThrow(() => appendHeaderFooterSummary(inspector, spec, {}));
  assert.equal(inspector.children.length, 0, 'nothing appended when the optional callback is absent');
});
