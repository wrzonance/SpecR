// Unit tests for the header/footer demo orchestrator (#477): library/project
// panel wiring + the section-inspector mount point. Run:
//   node --test examples/web_ui_demo/header-footer.test.mjs
// No jsdom in this repo — every DOM primitive (container, createElement) is
// injected as a fake so these tests exercise ONLY the wiring: which API calls
// fire, in what order, and whether a container is ever cleared vs. only
// appended to. Real DOM painting stays untested directly here, same split as
// header-footer-editor.test.mjs/download.test.mjs elsewhere in this demo.
//
// Pins three invariants from the design's spike learnings:
//   1. mountInspector(container, spec) only ever appends into `container` —
//      never clears/replaces its pre-existing children (the container-
//      clearing bug the spike found: `#editor-inspector` already holds
//      CITES/CITED BY/EDITABILITY before this callback runs).
//   2. A successful project-scope Save re-fetches and repaints the sibling
//      Effective Resolution panel immediately via onSaved — it is never left
//      showing stale layers/winning-scope until a view switch.
//   3. Client-scope header/footer API calls fire only when the selected
//      library's tier is exactly 'client' — mirroring the server's
//      requireClientLibrary gate so the UI never fires a call guaranteed to
//      400/404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initHeaderFooter } from './js/header-footer.js';

// A fake DOM element good enough for header-footer.js's internal `el()`
// helper (className/textContent/type/title assignment, appendChild,
// addEventListener) — no jsdom, so nothing here is a real Node.
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

// A fake mount-point container that tracks whether it was ever CLEARED
// (replaceChildren) vs. only ever appended to — the exact distinction
// invariant #1 pins. `innerHTML =` would also clear in a real DOM, but this
// module never assigns it, so tracking replaceChildren is the meaningful trap.
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
    createEditor: () => ({ refresh: async () => {} }),
    getClientHeaderFooter: noop,
    putClientHeaderFooter: noop,
    deleteClientHeaderFooter: noop,
    getProjectHeaderFooter: noop,
    putProjectHeaderFooter: noop,
    deleteProjectHeaderFooter: noop,
    getProjectHeaderFooterResolved: async () => ({ layers: [] }),
    fetchSpecDocx: noop,
    triggerBlobDownload: () => {},
    createElement: fakeElement,
    ...overrides,
  };
}

function baseCtx(overrides = {}) {
  return {
    getSelectedLibraryTier: () => null,
    getSelectedLibraryId: () => null,
    getActiveProjectId: () => null,
    libraryContainer: fakeContainer(),
    projectEditorContainer: fakeContainer(),
    projectResolutionContainer: fakeContainer(),
    toast: () => {},
    ...overrides,
  };
}

// --- Invariant 1: mountInspector never clears its container ---------------

test('mountInspector: appends exactly one wrapper, never clears the container’s pre-existing children', () => {
  const preexisting = [{ id: 'cites' }, { id: 'cited-by' }, { id: 'editability' }];
  const container = fakeContainer(preexisting);
  const hf = initHeaderFooter(baseCtx(), baseDeps());

  hf.mountInspector(container, { id: 'spec-1', section: '09 91 26' });

  assert.equal(container.clearedCount, 0, 'container.replaceChildren must never be called');
  assert.deepEqual(
    container.children.slice(0, 3),
    preexisting,
    'pre-existing inspector content (CITES/CITED BY/EDITABILITY) survives untouched'
  );
  assert.equal(container.children.length, 4, 'exactly one wrapper is appended');
});

test('mountInspector: called twice appends a second wrapper without ever clearing the first', () => {
  const container = fakeContainer([{ id: 'cites' }]);
  const hf = initHeaderFooter(baseCtx(), baseDeps());

  hf.mountInspector(container, { id: 'spec-1', section: '09 91 26' });
  hf.mountInspector(container, { id: 'spec-1', section: '09 91 26' });

  assert.equal(container.clearedCount, 0);
  assert.equal(
    container.children.length,
    3,
    'pre-existing content plus two wrappers, nothing removed'
  );
});

// --- Invariant 2: Save repaints the sibling resolution panel immediately --

test('refreshProjectPanel: Save (onSaved) re-fetches and repaints the Effective Resolution panel immediately — never stale', async () => {
  const resolvedResponses = [
    { layers: [{ scope: { kind: 'client', clientLibraryId: 'lib-1' }, config: {} }] },
    {
      layers: [
        { scope: { kind: 'client', clientLibraryId: 'lib-1' }, config: {} },
        { scope: { kind: 'project', projectId: 'proj-1' }, config: {} },
      ],
    },
  ];
  const resolvedCalls = [];
  let capturedEditorCtx = null;
  const deps = baseDeps({
    createEditor: (editorCtx) => {
      capturedEditorCtx = editorCtx;
      return { refresh: async () => {} };
    },
    getProjectHeaderFooterResolved: async (projectId) => {
      resolvedCalls.push(projectId);
      return resolvedResponses[resolvedCalls.length - 1];
    },
  });
  const resolutionContainer = fakeContainer();
  const ctx = baseCtx({
    getActiveProjectId: () => 'proj-1',
    projectResolutionContainer: resolutionContainer,
  });
  const hf = initHeaderFooter(ctx, deps);

  await hf.refreshProjectPanel();
  assert.equal(resolvedCalls.length, 1, 'the panel loads once on the initial refresh');
  assert.deepEqual(resolvedCalls, ['proj-1']);
  assert.ok(capturedEditorCtx, 'the project editor was constructed');
  assert.equal(
    typeof capturedEditorCtx.onSaved,
    'function',
    'onSaved is wired into the editor ctx'
  );
  const winnerAfterLoad = resolutionContainer.children[0].children[0].textContent;
  assert.match(winnerAfterLoad, /Client library/);

  // Simulate a successful Save completing — invoked exactly the way
  // saveDraft() calls it: AFTER ctx.put has already resolved.
  await capturedEditorCtx.onSaved();

  assert.equal(
    resolvedCalls.length,
    2,
    'onSaved must re-fetch the resolution itself — not rely on the next refreshProjectPanel()/a view switch'
  );
  const winnerAfterSave = resolutionContainer.children[0].children[0].textContent;
  assert.match(
    winnerAfterSave,
    /Project/,
    'the repainted panel reflects the NEW winning scope, not the stale pre-save one'
  );
});

test('refreshProjectPanel: no project selected — clears both panels and never calls the resolved API', async () => {
  const resolvedCalls = [];
  const deps = baseDeps({
    getProjectHeaderFooterResolved: async (projectId) => {
      resolvedCalls.push(projectId);
      return { layers: [] };
    },
  });
  const editorContainer = fakeContainer([{ id: 'stale-editor' }]);
  const resolutionContainer = fakeContainer([{ id: 'stale-resolution' }]);
  const ctx = baseCtx({
    getActiveProjectId: () => null,
    projectEditorContainer: editorContainer,
    projectResolutionContainer: resolutionContainer,
  });
  const hf = initHeaderFooter(ctx, deps);

  await hf.refreshProjectPanel();

  assert.equal(resolvedCalls.length, 0);
  assert.equal(editorContainer.children.length, 0);
  assert.equal(resolutionContainer.children.length, 0);
});

// --- Invariant 3: client API calls fire only when tier === 'client' -------

test('refreshLibraryPanel: client-scope API calls never fire unless tier is exactly "client"', async () => {
  for (const tier of [null, undefined, 'reference', 'company', 'CLIENT', 'client-ish']) {
    const getCalls = [];
    const deps = baseDeps({
      createEditor: (editorCtx) => ({
        refresh: async () => {
          await editorCtx.get();
        },
      }),
      getClientHeaderFooter: async (id) => {
        getCalls.push(id);
        return null;
      },
    });
    const ctx = baseCtx({
      getSelectedLibraryTier: () => tier,
      getSelectedLibraryId: () => 'lib-1',
    });
    const hf = initHeaderFooter(ctx, deps);

    await hf.refreshLibraryPanel();

    assert.equal(
      getCalls.length,
      0,
      `tier ${String(tier)} must never call the client header/footer API`
    );
  }
});

test('refreshLibraryPanel: client tier calls the client-scope API exactly once per refresh, for the current library id', async () => {
  const getCalls = [];
  const deps = baseDeps({
    createEditor: (editorCtx) => ({
      refresh: async () => {
        await editorCtx.get();
      },
    }),
    getClientHeaderFooter: async (id) => {
      getCalls.push(id);
      return null;
    },
  });
  const ctx = baseCtx({
    getSelectedLibraryTier: () => 'client',
    getSelectedLibraryId: () => 'lib-9',
  });
  const hf = initHeaderFooter(ctx, deps);

  await hf.refreshLibraryPanel();
  await hf.refreshLibraryPanel();

  assert.deepEqual(getCalls, ['lib-9', 'lib-9']);
});

test('refreshLibraryPanel: switching tier away from "client" stops firing the client API on the next refresh', async () => {
  const getCalls = [];
  let tier = 'client';
  const deps = baseDeps({
    createEditor: (editorCtx) => ({
      refresh: async () => {
        await editorCtx.get();
      },
    }),
    getClientHeaderFooter: async (id) => {
      getCalls.push(id);
      return null;
    },
  });
  const ctx = baseCtx({ getSelectedLibraryTier: () => tier, getSelectedLibraryId: () => 'lib-1' });
  const hf = initHeaderFooter(ctx, deps);

  await hf.refreshLibraryPanel();
  assert.equal(getCalls.length, 1);

  tier = 'company';
  await hf.refreshLibraryPanel();
  assert.equal(getCalls.length, 1, 'no new client API call once the tier is no longer client');
});
