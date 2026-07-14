// Unit tests for the header/footer editor's draft controller (#477). Run:
//   node --test examples/web_ui_demo/header-footer-editor.test.mjs
// No jsdom in this repo — these tests exercise ONLY the DOM-free draft
// controller (createDraft/editField/addField/removeField/editPageNumbering/
// saveDraft); initHeaderFooterEditor's DOM wiring is untested directly here,
// same split as download.js/header-footer-preview-view.js elsewhere in this
// demo (pure/testable logic vs. untested DOM paint).
//
// Pins two invariants from the spike (see the design's decisions):
//   1. Every field/cell/pageNumbering edit mutates only the local in-memory
//      draft — ctx.put() is invoked exactly once, only by an explicit
//      saveDraft() call (the Save button's handler), never per-keystroke.
//   2. saveDraft() always PUTs the full previously-loaded composition with
//      only the exact edited path shallow-patched — never a fresh object
//      rebuilt from just the fields the editor UI happens to know about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDraft,
  editField,
  addField,
  removeField,
  editPageNumbering,
  saveDraft,
  loadDraft,
  deleteDraft,
  resolveRefreshOutcome,
} from './js/header-footer-editor.js';
import { createRequestGuard } from './js/request-guard.mjs';

test('createDraft: seeds an empty composition and dirty:false for null/undefined', () => {
  assert.deepEqual(createDraft(null), { composition: {}, dirty: false });
  assert.deepEqual(createDraft(undefined), { composition: {}, dirty: false });
});

test('createDraft: wraps an existing composition as-is, not dirty', () => {
  const composition = { pageNumbering: { mode: 'continuous' } };
  assert.deepEqual(createDraft(composition), { composition, dirty: false });
});

test('editField: local-only edit lands at the exact path, flips dirty, never mutates the source, and preserves unrelated data at every level', () => {
  const original = {
    variants: {
      default: { header: { left: { content: [{ kind: 'literal', text: 'v1' }] } } },
      first: { header: { left: { content: [{ kind: 'date' }] } } }, // untouched sibling variant
    },
    pageNumbering: { mode: 'continuous' },
    raw: { warnings: ['unsupported OOXML detail'] },
    custom: 'keep-me', // unknown top-level catchall key (ADR-021) the editor UI has no control for
  };
  const draft0 = createDraft(original);

  const draft1 = editField(draft0, 'default', 'header', 'left', 0, { kind: 'literal', text: 'v2' });

  assert.equal(draft1.dirty, true);
  assert.equal(
    original.variants.default.header.left.content[0].text,
    'v1',
    'source composition untouched'
  );
  assert.equal(
    draft1.composition.variants.default.header.left.content[0].text,
    'v2',
    'edit landed at its path'
  );
  assert.deepEqual(
    draft1.composition.variants.first,
    original.variants.first,
    'unrelated variant survives'
  );
  assert.deepEqual(
    draft1.composition.pageNumbering,
    original.pageNumbering,
    'sibling top-level field survives'
  );
  assert.deepEqual(draft1.composition.raw, original.raw, 'raw sidecar survives');
  assert.equal(draft1.composition.custom, 'keep-me', 'unknown catchall key survives');
});

test('addField / removeField: local-only, only the targeted cell changes — sibling cells untouched', () => {
  const original = {
    variants: {
      default: {
        header: { left: { content: [] }, right: { content: [{ kind: 'date' }] } },
      },
    },
  };
  const draft0 = createDraft(original);

  const draft1 = addField(draft0, 'default', 'header', 'left', { kind: 'sectionNumber' });
  assert.equal(draft1.dirty, true);
  assert.deepEqual(draft1.composition.variants.default.header.left.content, [
    { kind: 'sectionNumber' },
  ]);
  assert.deepEqual(
    draft1.composition.variants.default.header.right,
    original.variants.default.header.right,
    'untouched sibling cell survives'
  );

  const draft2 = removeField(draft1, 'default', 'header', 'left', 0);
  assert.deepEqual(draft2.composition.variants.default.header.left.content, []);
});

test('editPageNumbering: local-only replace; passing undefined clears the policy', () => {
  const draft0 = createDraft({ pageNumbering: { mode: 'continuous' }, custom: 'x' });

  const draft1 = editPageNumbering(draft0, { mode: 'restartPerSpec', startAt: 3 });
  assert.deepEqual(draft1.composition.pageNumbering, { mode: 'restartPerSpec', startAt: 3 });
  assert.equal(draft1.composition.custom, 'x', 'unrelated field survives');

  const draft2 = editPageNumbering(draft1, undefined);
  assert.equal(draft2.composition.pageNumbering, undefined);
});

test('saveDraft: ctx.put is invoked exactly once no matter how many local edits preceded it', async () => {
  const original = {
    variants: { default: { header: { left: { content: [{ kind: 'literal', text: 'a' }] } } } },
    custom: 'keep',
  };
  let draft = createDraft(original);
  // Simulate several keystrokes/micro-edits before Save is ever clicked.
  draft = editField(draft, 'default', 'header', 'left', 0, { kind: 'literal', text: 'b' });
  draft = editField(draft, 'default', 'header', 'left', 0, { kind: 'literal', text: 'c' });
  draft = addField(draft, 'default', 'header', 'left', { kind: 'date' });

  const putCalls = [];
  const ctx = {
    put: async (composition) => {
      putCalls.push(composition);
      return { ...composition, serverStamped: true };
    },
    onSaved: () => {},
  };

  const saved = await saveDraft(ctx, draft);

  assert.equal(putCalls.length, 1, 'ctx.put must be invoked exactly once, only on Save');
  assert.equal(
    putCalls[0].variants.default.header.left.content[0].text,
    'c',
    'PUT carries the latest local edit'
  );
  assert.equal(
    putCalls[0].custom,
    'keep',
    'PUT is the full previously-loaded composition, never rebuilt from only fields the UI edited'
  );
  assert.equal(saved.dirty, false, 'a freshly saved draft is no longer dirty');
  assert.equal(
    saved.composition.serverStamped,
    true,
    'save reflects the server round-tripped value'
  );
});

test('saveDraft: never invokes ctx.put when no save is requested (edits alone are not enough)', () => {
  // A real ctx.put SPY stays in scope through every local edit below, so
  // this actually proves the claim its title makes — editField/addField/
  // removeField/editPageNumbering take no ctx parameter at all, so there is
  // no path from a local edit to a network call, but asserting the spy's
  // call count (rather than merely re-checking the draft shape, which the
  // 'addField / removeField' and 'editPageNumbering' tests above already
  // pin) is what makes this test capable of failing for the reason it claims.
  const putCalls = [];
  const ctx = {
    put: async (composition) => {
      putCalls.push(composition);
      return composition;
    },
    onSaved: () => {},
  };

  let draft = createDraft({});
  draft = addField(draft, 'default', 'header', 'left', { kind: 'literal', text: 'x' });
  draft = addField(draft, 'default', 'footer', 'right', { kind: 'date' });
  draft = editPageNumbering(draft, { mode: 'continuous' });

  assert.equal(
    putCalls.length,
    0,
    'ctx.put must not fire from local edits alone — only saveDraft() invokes it'
  );
  assert.equal(draft.dirty, true);
});

test('saveDraft: onSaved fires after ctx.put resolves and before saveDraft itself resolves', async () => {
  const order = [];
  const ctx = {
    put: async (composition) => {
      order.push('put');
      return composition;
    },
    onSaved: () => order.push('onSaved'),
  };

  await saveDraft(ctx, createDraft({}));

  assert.deepEqual(order, ['put', 'onSaved']);
});

test('saveDraft: falls back to the drafted composition when ctx.put resolves nothing usable', async () => {
  const ctx = { put: async () => undefined, onSaved: () => {} };
  const draft = editField(createDraft({}), 'default', 'header', 'left', 0, {
    kind: 'literal',
    text: 'x',
  });

  const saved = await saveDraft(ctx, draft);

  assert.deepEqual(saved.composition, draft.composition);
  assert.equal(saved.dirty, false);
});

// ── loadDraft — ctx-only, pins the refresh() error-vs-empty split ─────────
//
// ctx.get()'s documented contract distinguishes "genuinely not configured
// yet" (resolves null) from a real failure (REJECTS — network error, 5xx, a
// malformed envelope; see api.js's getJsonOrNull). A rejection must never be
// folded into the same outcome as a genuine null: 'empty' is what unlocks
// the "Create configuration" -> Save UI, and Save always fires a full-
// composition ctx.put() — collapsing a transient GET failure into 'empty'
// would let that Save silently overwrite whatever is actually stored.

test('loadDraft: ctx.get() resolving null lands in "empty" — the genuinely-not-configured state', async () => {
  const outcome = await loadDraft({ get: async () => null });
  assert.deepEqual(outcome, { status: 'empty' });
});

test('loadDraft: ctx.get() resolving a composition lands in "loaded" with a fresh, non-dirty draft', async () => {
  const composition = { variants: { default: { header: {} } } };
  const outcome = await loadDraft({ get: async () => composition });
  assert.equal(outcome.status, 'loaded');
  assert.deepEqual(outcome.draft, { composition, dirty: false });
});

test('loadDraft: ctx.get() REJECTING (transient failure) lands in "error", never "empty"', async () => {
  const outcome = await loadDraft({
    get: async () => {
      throw new Error('network error');
    },
  });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.message, 'network error');
});

// ── deleteDraft — ctx-only, pins onSaved firing on every successful delete ─

test('deleteDraft: a successful ctx.del() fires ctx.onSaved() before resolving', async () => {
  const order = [];
  const ctx = {
    del: async () => {
      order.push('del');
    },
    onSaved: () => order.push('onSaved'),
  };

  const outcome = await deleteDraft(ctx);

  assert.deepEqual(order, ['del', 'onSaved']);
  assert.equal(outcome.alreadyRemoved, false);
  assert.deepEqual(outcome.draft, { composition: {}, dirty: false });
});

test('deleteDraft: a 404 (already removed server-side) is treated as success and still fires ctx.onSaved()', async () => {
  const order = [];
  const notFound = Object.assign(new Error('not found'), { status: 404 });
  const ctx = {
    del: async () => {
      throw notFound;
    },
    onSaved: () => order.push('onSaved'),
  };

  const outcome = await deleteDraft(ctx);

  assert.deepEqual(order, ['onSaved']);
  assert.equal(outcome.alreadyRemoved, true);
});

test('deleteDraft: a non-404 failure re-throws and never fires ctx.onSaved()', async () => {
  let onSavedCalls = 0;
  const serverError = Object.assign(new Error('server error'), { status: 500 });
  const ctx = {
    del: async () => {
      throw serverError;
    },
    onSaved: () => {
      onSavedCalls += 1;
    },
  };

  await assert.rejects(() => deleteDraft(ctx), /server error/);
  assert.equal(onSavedCalls, 0, 'onSaved must never fire when the delete genuinely failed');
});

// ── resolveRefreshOutcome — pure re-entrancy guard for refresh() ──────────
//
// Regression: initHeaderFooterEditor's refresh() had no guard against
// overlapping calls on the SAME memoized instance (e.g. header-footer.js's
// refreshLibraryPanel/refreshProjectPanel re-invoking .refresh() on a rapid
// selection change, while a slower earlier ctx.get() is still in flight). If
// the OLDER request's response happens to arrive AFTER the newer one's, it
// would silently overwrite the editor's draft/mode with stale data for the
// wrong scope — and a later Save would PUT that stale draft to whatever
// scope is CURRENTLY selected, not the one it was actually loaded for. This
// mirrors scoring.js's loadSelected guard (see request-guard.mjs), applied
// here as a pure function so the guard decision itself is testable without
// the real DOM initHeaderFooterEditor's refresh()/render() require.

test('resolveRefreshOutcome: a stale token (superseded by a newer refresh()) is never applied', () => {
  const guard = createRequestGuard();
  const staleToken = guard.next(); // the older, slower refresh() call
  guard.next(); // a newer refresh() call started before the older one resolved
  const composition = { variants: { default: { header: {} } } };

  const result = resolveRefreshOutcome(guard, staleToken, {
    status: 'loaded',
    draft: createDraft(composition),
  });

  assert.deepEqual(
    result,
    { applied: false },
    'the older call must never apply its outcome once a newer refresh() has started'
  );
});

test('resolveRefreshOutcome: the current (latest) token applies a "loaded" outcome', () => {
  const guard = createRequestGuard();
  const token = guard.next();
  const draft = createDraft({ variants: { default: { header: {} } } });

  const result = resolveRefreshOutcome(guard, token, { status: 'loaded', draft });

  assert.deepEqual(result, {
    applied: true,
    mode: 'editing',
    draft,
    hasPersistedConfig: true,
  });
});

test('resolveRefreshOutcome: the current token applies an "empty" outcome as a fresh, non-dirty draft', () => {
  const guard = createRequestGuard();
  const token = guard.next();

  const result = resolveRefreshOutcome(guard, token, { status: 'empty' });

  assert.deepEqual(result, {
    applied: true,
    mode: 'empty',
    draft: { composition: {}, dirty: false },
    hasPersistedConfig: false,
  });
});

test('resolveRefreshOutcome: the current token applies an "error" outcome without touching draft/hasPersistedConfig', () => {
  const guard = createRequestGuard();
  const token = guard.next();

  const result = resolveRefreshOutcome(guard, token, { status: 'error', message: 'network error' });

  assert.deepEqual(result, { applied: true, mode: 'error', errorMessage: 'network error' });
});

test('resolveRefreshOutcome: bump() (editor torn down mid-flight) invalidates the in-flight token too', () => {
  // Mirrors header-footer.js invalidating a memoized editor's in-flight
  // refresh() when the panel becomes invisible (tier change / no project
  // selected) — the stale response must not repaint a container that no
  // longer belongs to this editor.
  const guard = createRequestGuard();
  const token = guard.next();
  guard.bump();

  const result = resolveRefreshOutcome(guard, token, { status: 'empty' });

  assert.deepEqual(result, { applied: false });
});
