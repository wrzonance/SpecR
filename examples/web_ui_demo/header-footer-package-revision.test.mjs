// Unit tests for the package/revision header/footer demo orchestrator
// (#481): package-scope and revision-scope panel wiring, plus the
// revision-only Download DOCX action. Run:
//   node --test examples/web_ui_demo/header-footer-package-revision.test.mjs
// No jsdom in this repo — every DOM primitive is injected as a fake, mirroring
// header-footer.test.mjs's convention: these tests exercise ONLY the wiring
// (which API calls fire, in what order, whether a container is ever cleared
// vs. only appended to), never real DOM painting.
//
// Pins the invariants specific to this module (the client/project parity
// invariants — envelope unwrap, invalidate()-on-deselect, live
// getPreviewContext — are already pinned once for that shared shape by
// header-footer.test.mjs; this file does not re-litigate them per scope):
//   1. MANDATORY (spike-proven): packageResolutionGuard and
//      revisionResolutionGuard are two INDEPENDENT createRequestGuard()
//      instances. refreshPackagePanel and refreshRevisionPanel firing in the
//      SAME tick (e.g. page load with both UUID inputs pre-filled) must never
//      let one scope's token bump drop the other scope's still-legitimate
//      in-flight resolution response — a single shared guard breaks this on
//      ordinary use, not just adversarial timing.
//   2. The package panel is CRUD-only: refreshPackagePanel never touches
//      Download-DOCX machinery (no generate route exists for packages).
//   3. downloadRevisionDocx mirrors downloadSpecDocx's try/catch +
//      status-specific toast pattern (header-footer.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initPackageRevisionHeaderFooter } from './js/header-footer-package-revision.js';

// Mirrors header-footer.test.mjs's fakeElement — good enough for this
// module's internal `el()` helper (className/textContent/type/title
// assignment, appendChild, addEventListener).
function fakeElement(tag) {
  return {
    tag,
    className: '',
    textContent: '',
    type: '',
    title: '',
    children: [],
    listeners: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

// Mirrors header-footer.test.mjs's fakeContainer — tracks whether it was
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

function baseDeps(overrides = {}) {
  const noop = async () => null;
  return {
    createEditor: () => ({ refresh: async () => {}, invalidate: () => {} }),
    getPackageHeaderFooter: noop,
    putPackageHeaderFooter: noop,
    deletePackageHeaderFooter: noop,
    getPackageHeaderFooterResolved: async () => ({ layers: [] }),
    getRevisionHeaderFooter: noop,
    putRevisionHeaderFooter: noop,
    deleteRevisionHeaderFooter: noop,
    getRevisionHeaderFooterResolved: async () => ({ layers: [] }),
    fetchRevisionDocx: noop,
    triggerBlobDownload: () => {},
    createElement: fakeElement,
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    getSelectedPackageId: () => null,
    getSelectedRevisionId: () => null,
    packageEditorContainer: fakeContainer(),
    packageResolutionContainer: fakeContainer(),
    revisionEditorContainer: fakeContainer(),
    revisionResolutionContainer: fakeContainer(),
    revisionDownloadContainer: fakeContainer(),
    toast: () => {},
    ...overrides,
  };
}

// --- Invariant 1: independent guards — the star regression test -----------

test("REGRESSION: refreshPackagePanel and refreshRevisionPanel firing in the same tick must not drop either scope's resolution response — independent createRequestGuard per scope", async () => {
  const packageResolved = {
    layers: [{ scope: { kind: 'package', packageId: 'pkg-1' }, config: {} }],
  };
  const revisionResolved = {
    layers: [{ scope: { kind: 'revision', revisionId: 'rev-1' }, config: {} }],
  };
  const calls = [];
  const deps = baseDeps({
    getPackageHeaderFooterResolved: async (id) => {
      calls.push(`package:${id}`);
      return packageResolved;
    },
    getRevisionHeaderFooterResolved: async (id) => {
      calls.push(`revision:${id}`);
      return revisionResolved;
    },
  });
  const packageResolutionContainer = fakeContainer();
  const revisionResolutionContainer = fakeContainer();
  const ctx = baseCtx({
    getSelectedPackageId: () => 'pkg-1',
    getSelectedRevisionId: () => 'rev-1',
    packageResolutionContainer,
    revisionResolutionContainer,
  });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  // Fire both in the SAME tick — neither is awaited before the other starts,
  // exactly the "page load with both UUID inputs pre-filled" scenario the
  // spike reproduced. A shared guard would have its `current` counter bumped
  // twice (once per scope) before either fetch resolves, silently
  // invalidating whichever scope issued its token first.
  const packageRefresh = hf.refreshPackagePanel();
  const revisionRefresh = hf.refreshRevisionPanel();
  await Promise.all([packageRefresh, revisionRefresh]);

  assert.deepEqual(calls, ['package:pkg-1', 'revision:rev-1']);
  assert.equal(
    packageResolutionContainer.children.length,
    1,
    'package resolution panel must still be painted — a shared guard would have dropped it'
  );
  assert.match(packageResolutionContainer.children[0].children[0].textContent, /Package/);
  assert.equal(
    revisionResolutionContainer.children.length,
    1,
    'revision resolution panel must still be painted'
  );
  assert.match(revisionResolutionContainer.children[0].children[0].textContent, /Revision/);
});

test('REGRESSION: a slow package resolution response resolving AFTER a second same-tick package refresh must not repaint with stale data', async () => {
  const responses = [
    { layers: [{ scope: { kind: 'client', clientLibraryId: 'lib-1' }, config: {} }] },
    { layers: [{ scope: { kind: 'package', packageId: 'pkg-1' }, config: {} }] },
  ];
  let resolveFirst;
  let callIndex = 0;
  const deps = baseDeps({
    getPackageHeaderFooterResolved: async () => {
      const index = callIndex;
      callIndex += 1;
      if (index === 0) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve(responses[0]);
        });
      }
      return responses[1];
    },
  });
  const packageResolutionContainer = fakeContainer();
  const ctx = baseCtx({ getSelectedPackageId: () => 'pkg-1', packageResolutionContainer });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  const firstRefresh = hf.refreshPackagePanel(); // issues token 1, ctx.get() never resolves yet
  await hf.refreshPackagePanel(); // issues token 2, resolves with responses[1]

  assert.equal(packageResolutionContainer.children.length, 1);
  assert.match(packageResolutionContainer.children[0].children[0].textContent, /Package/);

  resolveFirst(); // let the stale response settle — must be a no-op
  await firstRefresh;

  assert.equal(
    packageResolutionContainer.children.length,
    1,
    'the stale first response must never repaint over the newer one'
  );
  assert.match(
    packageResolutionContainer.children[0].children[0].textContent,
    /Package/,
    'the panel still reflects the newer (second) response, not the stale first one'
  );
});

test('refreshPackagePanel/refreshRevisionPanel: no id selected — clears both panels for that scope and never calls its resolved API', async () => {
  const resolvedCalls = [];
  const deps = baseDeps({
    getPackageHeaderFooterResolved: async () => {
      resolvedCalls.push('package');
      return { layers: [] };
    },
    getRevisionHeaderFooterResolved: async () => {
      resolvedCalls.push('revision');
      return { layers: [] };
    },
  });
  const packageEditorContainer = fakeContainer([{ id: 'stale-package-editor' }]);
  const packageResolutionContainer = fakeContainer([{ id: 'stale-package-resolution' }]);
  const revisionEditorContainer = fakeContainer([{ id: 'stale-revision-editor' }]);
  const revisionResolutionContainer = fakeContainer([{ id: 'stale-revision-resolution' }]);
  const revisionDownloadContainer = fakeContainer([{ id: 'stale-download' }]);
  const ctx = baseCtx({
    getSelectedPackageId: () => null,
    getSelectedRevisionId: () => null,
    packageEditorContainer,
    packageResolutionContainer,
    revisionEditorContainer,
    revisionResolutionContainer,
    revisionDownloadContainer,
  });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshPackagePanel();
  await hf.refreshRevisionPanel();

  assert.equal(resolvedCalls.length, 0);
  assert.equal(packageEditorContainer.children.length, 0);
  assert.equal(packageResolutionContainer.children.length, 0);
  assert.equal(revisionEditorContainer.children.length, 0);
  assert.equal(revisionResolutionContainer.children.length, 0);
  assert.equal(
    revisionDownloadContainer.children.length,
    0,
    'the Download DOCX button is cleared when no revision is selected'
  );
});

// --- CRUD envelope unwrap (mirrors header-footer.js's contract, exercised
// once per scope here since each scope binds its own get/put closures) -----

test('packageEditorCtx.get/put: unwrap the API record to its bare composition, not the envelope', async () => {
  const STORED_COMPOSITION = { variants: { default: { header: {} } } };
  const record = (config) => ({ id: 'cfg-1', scope: { kind: 'package' }, config });
  let capturedEditorCtx = null;
  const deps = baseDeps({
    createEditor: (editorCtx) => {
      capturedEditorCtx = editorCtx;
      return { refresh: async () => {}, invalidate: () => {} };
    },
    getPackageHeaderFooter: async () => record(STORED_COMPOSITION),
    putPackageHeaderFooter: async (_id, composition) => record(composition),
  });
  const ctx = baseCtx({ getSelectedPackageId: () => 'pkg-1' });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshPackagePanel();

  assert.deepEqual(await capturedEditorCtx.get(), STORED_COMPOSITION);
  assert.deepEqual(await capturedEditorCtx.put(STORED_COMPOSITION), STORED_COMPOSITION);
});

test('revisionEditorCtx.get/put: unwrap the API record to its bare composition, not the envelope', async () => {
  const STORED_COMPOSITION = { variants: { default: { footer: {} } } };
  const record = (config) => ({ id: 'cfg-2', scope: { kind: 'revision' }, config });
  let capturedEditorCtx = null;
  const deps = baseDeps({
    createEditor: (editorCtx) => {
      capturedEditorCtx = editorCtx;
      return { refresh: async () => {}, invalidate: () => {} };
    },
    getRevisionHeaderFooter: async () => record(STORED_COMPOSITION),
    putRevisionHeaderFooter: async (_id, composition) => record(composition),
  });
  const ctx = baseCtx({ getSelectedRevisionId: () => 'rev-1' });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshRevisionPanel();

  assert.deepEqual(await capturedEditorCtx.get(), STORED_COMPOSITION);
  assert.deepEqual(await capturedEditorCtx.put(STORED_COMPOSITION), STORED_COMPOSITION);
});

// --- Invariant 2: package panel is CRUD-only -------------------------------

test('refreshPackagePanel: never touches Download-DOCX machinery — no generate route exists for packages', async () => {
  const fetchCalls = [];
  const deps = baseDeps({
    fetchRevisionDocx: async (id) => {
      fetchCalls.push(id);
      return new Blob();
    },
  });
  const ctx = baseCtx({ getSelectedPackageId: () => 'pkg-1' });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshPackagePanel();

  assert.equal(fetchCalls.length, 0, 'no DOCX fetch fires for a package-scope refresh');
  assert.equal(
    ctx.revisionDownloadContainer.children.length,
    0,
    'the package panel never paints into the revision download container'
  );
});

// --- Invariant 3: downloadRevisionDocx mirrors downloadSpecDocx's pattern --

test('refreshRevisionPanel: mounts a Download DOCX button that downloads and toasts on success', async () => {
  const downloads = [];
  const toasts = [];
  const deps = baseDeps({
    fetchRevisionDocx: async (id) => {
      assert.equal(id, 'rev-1');
      return { blobFor: id };
    },
    triggerBlobDownload: (blob, filename) => downloads.push({ blob, filename }),
  });
  const ctx = baseCtx({
    getSelectedRevisionId: () => 'rev-1',
    toast: (message, kind) => toasts.push({ message, kind }),
  });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshRevisionPanel();
  const button = ctx.revisionDownloadContainer.children.find((c) => c.tag === 'button');
  assert.ok(button, 'a Download DOCX button is mounted');

  await button.listeners.click();

  assert.deepEqual(downloads, [{ blob: { blobFor: 'rev-1' }, filename: 'revision-rev-1.docx' }]);
  assert.deepEqual(toasts, [{ message: 'Downloaded revision DOCX', kind: undefined }]);
});

test('refreshRevisionPanel: Download DOCX button toasts a status-specific error and never throws on failure', async () => {
  const toasts = [];
  const deps = baseDeps({
    fetchRevisionDocx: async () => {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    },
  });
  const ctx = baseCtx({
    getSelectedRevisionId: () => 'rev-1',
    toast: (message, kind) => toasts.push({ message, kind }),
  });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshRevisionPanel();
  const button = ctx.revisionDownloadContainer.children.find((c) => c.tag === 'button');

  await button.listeners.click();

  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].kind, 'err');
  assert.match(toasts[0].message, /rev-1/);
});

// --- Save repaints the sibling resolution panel for its OWN scope only,
// mirroring header-footer.js's onSaved contract per scope. -----------------

test('onSaved (package): re-fetches and repaints ONLY the package resolution panel, never the revision one', async () => {
  const resolvedCalls = [];
  let capturedPackageCtx = null;
  const deps = baseDeps({
    // Only refreshPackagePanel() runs in this test, so createEditor is only
    // ever invoked once, for the package scope.
    createEditor: (editorCtx) => {
      capturedPackageCtx = editorCtx;
      return { refresh: async () => {}, invalidate: () => {} };
    },
    getPackageHeaderFooterResolved: async () => {
      resolvedCalls.push('package');
      return { layers: [{ scope: { kind: 'package', packageId: 'pkg-1' }, config: {} }] };
    },
    getRevisionHeaderFooterResolved: async () => {
      resolvedCalls.push('revision');
      return { layers: [] };
    },
  });
  const ctx = baseCtx({ getSelectedPackageId: () => 'pkg-1' });
  const hf = initPackageRevisionHeaderFooter(ctx, deps);

  await hf.refreshPackagePanel();
  assert.deepEqual(resolvedCalls, ['package']);
  assert.equal(typeof capturedPackageCtx.onSaved, 'function');

  await capturedPackageCtx.onSaved();

  assert.deepEqual(
    resolvedCalls,
    ['package', 'package'],
    'onSaved must re-fetch the package resolution — and never touch the revision one'
  );
});
