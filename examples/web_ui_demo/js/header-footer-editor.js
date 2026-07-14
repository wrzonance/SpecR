// Shared header/footer editor component (#477) — mounted once per scope
// (client library, project) by header-footer.js's refreshLibraryPanel /
// refreshProjectPanel. Scope-agnostic: this file has zero REST-path/scope-kind
// knowledge — the caller supplies `get`/`put`/`del` closures already bound to
// the right endpoint (see the `ctx` contract below).
//
// `ctx` shape:
//   container: HTMLElement                              — dedicated mount
//     point this component owns outright (replaces its entire contents on
//     every render — unlike `#editor-inspector`, there is nothing else in it
//     to preserve; see header-footer.js's mountInspector for that contract).
//   get: () => Promise<HeaderFooterComposition | null>   — loads the current
//     config, or null when none is configured at this scope yet.
//   put: (composition) => Promise<HeaderFooterComposition> — upserts the FULL
//     composition (never a partial patch — see api.js's header/footer
//     comment) and resolves with the server's stored (round-tripped) value.
//   del: () => Promise<void>                             — removes the config
//     at this scope. A 404 (already removed) is treated as success, not an
//     error — see deleteDraft below.
//   toast?: (message, kind?) => void                     — user feedback.
//   onSaved?: () => void                                 — called once
//     ctx.put() resolves (see saveDraft), OR once a delete completes —
//     success or the already-gone 404 (see deleteDraft) — in both cases
//     BEFORE this component repaints.
//   getPreviewContext?: () => PreviewFieldContext          — invoked FRESH
//     on every render (never memoized at mount time) and passed straight
//     through to header-footer-preview.mjs's buildPreviewModel. A plain
//     `previewContext` value would go stale for the lifetime of a memoized
//     editor instance (header-footer.js caches its editor and only calls
//     refresh() thereafter) — see that module's `previewContext()` closure.
//   emptyStateLabel?: string                              — copy for the
//     empty state's lead paragraph (defaults to a generic message).
//   loadErrorLabel?: string                               — copy for the
//     error state's lead paragraph, shown when ctx.get() REJECTS (see
//     loadDraft below) instead of resolving null (defaults to a generic
//     message). This state offers Retry only — never Create/Save.
//
// Returns `{ refresh }` — the caller invokes refresh() after mount and again
// whenever the selected library/project changes; ctx.get()/put()/del() are
// expected to read whatever is "currently selected" at call time.
//
// STATE: holds exactly one local `HeaderFooterEditorDraft` — `{ composition,
// dirty }` — mutated ONLY via the pure helpers below (editField/addField/
// removeField/editPageNumbering), which themselves delegate every read/write
// to header-footer-fields.mjs's selectVariant/withVariant/withCellField
// family. Every local edit re-renders the preview from the in-memory draft
// only; `ctx.put()` fires exclusively from saveDraft, itself called only by
// the explicit Save button (see the initHeaderFooterEditor invariant note).
// `ctx.get()`/`ctx.del()` are likewise each invoked from exactly one place —
// loadDraft/deleteDraft — so refresh()/onDelete() never touch ctx directly;
// this is what keeps the "is this ctx.get() failure a real error or a
// genuinely-empty scope?" decision (see loadDraft) in one pure, testable
// spot instead of duplicated across every DOM call site.
import {
  FIELD_KINDS,
  isFreetext,
  emptyField,
  selectVariant,
  withVariant,
  withPageNumbering,
  withCellField,
  addCellField,
  removeCellField,
} from './header-footer-fields.mjs';
import { buildPreviewModel } from './header-footer-preview.mjs';
import { renderPreview, renderVariantTabs } from './header-footer-preview-view.js';
import { openConfirm } from './modal.js';

// ── Draft controller — pure/ctx-only, no DOM. Exported for boundary tests. ──

/** A fresh `HeaderFooterEditorDraft` seeded from `composition` (or `{}`). */
export function createDraft(composition) {
  return { composition: composition ?? {}, dirty: false };
}

// A new variant with `region[cellPosition]` replaced by `cell`.
function withRegionCell(variant, regionKind, cellPosition, cell) {
  const region = { ...(variant?.[regionKind] ?? {}), [cellPosition]: cell };
  return { ...(variant ?? {}), [regionKind]: region };
}

// Reads the full composition's ONE targeted cell, applies `updateCell` to it,
// and writes the result back through withRegionCell + withVariant — i.e. a
// shallow patch of the exact path touched, always against the full loaded
// composition (never a fresh object built from only the fields the UI knows
// about).
function withVariantCell(composition, variantKey, regionKind, cellPosition, updateCell) {
  const variant = selectVariant(composition, variantKey) ?? {};
  const cell = variant[regionKind]?.[cellPosition];
  const updatedVariant = withRegionCell(variant, regionKind, cellPosition, updateCell(cell));
  return withVariant(composition, variantKey, updatedVariant);
}

/** A new draft with `content[index]` of the targeted cell replaced by `field`. */
export function editField(draft, variantKey, regionKind, cellPosition, index, field) {
  const composition = withVariantCell(
    draft.composition,
    variantKey,
    regionKind,
    cellPosition,
    (cell) => withCellField(cell, index, field)
  );
  return { composition, dirty: true };
}

/** A new draft with `field` appended to the targeted cell. */
export function addField(draft, variantKey, regionKind, cellPosition, field) {
  const composition = withVariantCell(
    draft.composition,
    variantKey,
    regionKind,
    cellPosition,
    (cell) => addCellField(cell, field)
  );
  return { composition, dirty: true };
}

/** A new draft with `content[index]` removed from the targeted cell. */
export function removeField(draft, variantKey, regionKind, cellPosition, index) {
  const composition = withVariantCell(
    draft.composition,
    variantKey,
    regionKind,
    cellPosition,
    (cell) => removeCellField(cell, index)
  );
  return { composition, dirty: true };
}

/** A new draft with `pageNumbering` replaced (undefined clears the policy). */
export function editPageNumbering(draft, pageNumbering) {
  return { composition: withPageNumbering(draft.composition, pageNumbering), dirty: true };
}

/**
 * Persists `draft.composition` via `ctx.put` — the ONLY call site in this
 * module that ever invokes ctx.put, and it fires exactly once per call,
 * regardless of how many local edits preceded it (editField/addField/
 * removeField/editPageNumbering never touch ctx). `ctx.onSaved?.()` runs
 * immediately after `ctx.put` resolves and BEFORE this resolves, so a caller
 * that awaits saveDraft and then repaints is guaranteed to repaint after
 * onSaved's own refresh has already happened (see the module doc's ctx
 * contract). Resolves with a fresh, non-dirty draft built from the server's
 * round-tripped composition (falling back to the drafted one if `put`
 * resolves nothing usable).
 */
export async function saveDraft(ctx, draft) {
  const saved = await ctx.put(draft.composition);
  ctx.onSaved?.();
  return createDraft(saved ?? draft.composition);
}

/**
 * Resolves `ctx.get()` into the editor's next state — the ONLY call site in
 * this module that ever invokes ctx.get. `ctx.get()`'s documented contract
 * is: resolve `null` for "genuinely not configured at this scope yet", or
 * REJECT for anything else (network error, 5xx, a malformed envelope — see
 * api.js's getJsonOrNull). A rejection must never collapse into the same
 * outcome a genuine null does — `{ status: 'empty' }` is what unlocks the
 * "Create configuration" -> Save UI, and Save always fires a full-
 * composition ctx.put() that would silently overwrite whatever is actually
 * stored server-side. A rejection instead resolves `{ status: 'error',
 * message }`, for the caller to render a distinct, non-destructive Retry
 * state from (no Create/Save reachable).
 */
export async function loadDraft(ctx) {
  try {
    const loaded = await ctx.get();
    if (loaded === null) return { status: 'empty' };
    return { status: 'loaded', draft: createDraft(loaded) };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * Deletes the persisted config via `ctx.del` — the ONLY call site in this
 * module that ever invokes ctx.del. A 404 (already removed server-side) is
 * folded into the same successful outcome as a real delete (see the module
 * doc's ctx contract) but reported back as `alreadyRemoved` so the caller can
 * still pick distinct toast copy. On EITHER successful outcome
 * `ctx.onSaved?.()` fires before this resolves — the same ordering saveDraft
 * gives Save — so a caller that awaits deleteDraft() and then repaints is
 * guaranteed to repaint after onSaved's own refresh has already run (this is
 * what keeps a project-scope delete's sibling Effective Resolution panel
 * from going stale). A non-404 failure re-throws untouched: nothing was
 * actually deleted, so onSaved must not fire.
 */
export async function deleteDraft(ctx) {
  let alreadyRemoved = false;
  try {
    await ctx.del();
  } catch (err) {
    if (err.status !== 404) throw err;
    alreadyRemoved = true;
  }
  ctx.onSaved?.();
  return { draft: createDraft({}), alreadyRemoved };
}

// ── DOM rendering — no jsdom in this repo, so nothing below is unit tested
// directly; the state transitions above are the tested boundary. Mirrors
// header-footer-preview-view.js's el()/textContent-only convention: field
// text is spec-author/client/project content, never trusted as markup. ──

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selectEl(className, options, value, onChange) {
  const select = document.createElement('select');
  select.className = className;
  for (const { value: optValue, label } of options) {
    const opt = document.createElement('option');
    opt.value = optValue;
    opt.textContent = label;
    select.appendChild(opt);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

const CELL_LABELS = { left: 'Left', center: 'Center', right: 'Right' };

function renderFieldRow(field, index, handlers) {
  const row = el('div', 'hf-field-row');
  row.appendChild(
    selectEl('hf-field-kind', FIELD_KINDS, field.kind, (kind) => handlers.onKindChange(index, kind))
  );
  if (isFreetext(field.kind)) {
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'hf-field-text';
    text.placeholder = 'Literal text';
    text.value = field.text ?? '';
    text.addEventListener('change', () => handlers.onTextChange(index, text.value));
    row.appendChild(text);
  }
  const remove = el('button', 'hf-field-remove', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => handlers.onRemove(index));
  row.appendChild(remove);
  return row;
}

function renderCellEditor(cellPosition, cell, handlers) {
  const wrap = el('div', 'hf-cell-editor');
  wrap.appendChild(el('div', 'hf-cell-label', CELL_LABELS[cellPosition]));
  const content = Array.isArray(cell?.content) ? cell.content : [];
  content.forEach((field, index) => wrap.appendChild(renderFieldRow(field, index, handlers)));
  const add = el('button', 'hf-cell-add', '+ Add field');
  add.type = 'button';
  add.addEventListener('click', () => handlers.onAdd());
  wrap.appendChild(add);
  return wrap;
}

function cellHandlers(regionKind, cellPosition, dispatch) {
  return {
    onKindChange: (index, kind) =>
      dispatch.onFieldEdit(regionKind, cellPosition, index, emptyField(kind)),
    onTextChange: (index, text) => dispatch.onFieldText(regionKind, cellPosition, index, text),
    onRemove: (index) => dispatch.onFieldRemove(regionKind, cellPosition, index),
    onAdd: () => dispatch.onFieldAdd(regionKind, cellPosition),
  };
}

function renderRegionEditor(regionKind, region, dispatch) {
  const wrap = el('div', 'hf-region-editor');
  wrap.appendChild(el('h4', 'hf-region-title', regionKind === 'header' ? 'Header' : 'Footer'));
  for (const cellPosition of ['left', 'center', 'right']) {
    const handlers = cellHandlers(regionKind, cellPosition, dispatch);
    wrap.appendChild(renderCellEditor(cellPosition, region?.[cellPosition], handlers));
  }
  return wrap;
}

const PAGE_NUMBERING_OPTIONS = [
  { value: '', label: 'Not configured (inherit)' },
  { value: 'continuous', label: 'Continuous across package' },
  { value: 'restartPerSpec', label: 'Restart each spec section' },
];

// undefined clears the policy entirely (JSON.stringify drops it — the same
// state as a composition that never had pageNumbering configured).
function buildPageNumbering(mode, startAtRaw) {
  if (!mode) return undefined;
  if (mode === 'continuous') return { mode: 'continuous' };
  const startAt = Number.parseInt(startAtRaw, 10);
  return {
    mode: 'restartPerSpec',
    startAt: Number.isFinite(startAt) && startAt >= 1 ? startAt : 1,
  };
}

function renderPageNumbering(pageNumbering, onChange) {
  const wrap = el('div', 'hf-pagenum');
  wrap.appendChild(el('label', 'hf-pagenum-label', 'Page numbering'));

  const startAtInput = document.createElement('input');
  startAtInput.type = 'number';
  startAtInput.className = 'hf-pagenum-startat';
  startAtInput.min = '1';
  startAtInput.value = String(pageNumbering?.startAt ?? 1);
  startAtInput.hidden = pageNumbering?.mode !== 'restartPerSpec';

  const emitChange = (mode) => onChange(buildPageNumbering(mode, startAtInput.value));
  const modeSelect = selectEl(
    'hf-pagenum-mode',
    PAGE_NUMBERING_OPTIONS,
    pageNumbering?.mode ?? '',
    (mode) => {
      startAtInput.hidden = mode !== 'restartPerSpec';
      emitChange(mode);
    }
  );
  startAtInput.addEventListener('change', () => emitChange(modeSelect.value));

  wrap.append(modeSelect, startAtInput);
  return wrap;
}

function renderEmptyState(container, onCreate, emptyStateLabel) {
  const wrap = el('div', 'hf-empty');
  wrap.appendChild(
    el('p', 'hf-empty-text', emptyStateLabel ?? 'No header/footer configuration at this scope yet.')
  );
  const create = el('button', 'hf-empty-create', 'Create configuration');
  create.type = 'button';
  create.addEventListener('click', onCreate);
  wrap.appendChild(create);
  container.appendChild(wrap);
}

// Deliberately offers ONLY Retry — never "Create configuration". Rendering
// this the same as renderEmptyState would let a transient load failure
// (network error, 500) be "fixed" via Create -> Save, which fires a
// destructive full-composition ctx.put() over whatever is actually stored
// (see loadDraft's doc comment).
function renderErrorState(container, onRetry, loadErrorLabel) {
  const wrap = el('div', 'hf-error');
  wrap.appendChild(
    el('p', 'hf-error-text', loadErrorLabel ?? 'Could not load header/footer configuration.')
  );
  const retry = el('button', 'hf-error-retry', 'Retry');
  retry.type = 'button';
  retry.addEventListener('click', () => void onRetry());
  wrap.appendChild(retry);
  container.appendChild(wrap);
}

function renderActions(container, draft, hasPersistedConfig, dispatch) {
  const actions = el('div', 'hf-editor-actions');
  const save = el('button', 'hf-save is-primary', 'Save');
  save.type = 'button';
  save.disabled = !draft.dirty;
  save.addEventListener('click', () => dispatch.onSave());
  actions.appendChild(save);
  if (hasPersistedConfig) {
    const del = el('button', 'hf-delete is-danger', 'Delete');
    del.type = 'button';
    del.addEventListener('click', () => dispatch.onDelete());
    actions.appendChild(del);
  }
  container.appendChild(actions);
}

function renderEditorBody(container, state, dispatch) {
  const { draft, activeVariant, hasPersistedConfig, previewContext } = state;
  const variant = selectVariant(draft.composition, activeVariant) ?? {};

  const tabsHost = el('div', 'hf-variant-tabs-host');
  container.appendChild(tabsHost);
  renderVariantTabs(tabsHost, activeVariant, dispatch.onVariantChange);

  container.appendChild(renderRegionEditor('header', variant.header, dispatch));
  container.appendChild(renderRegionEditor('footer', variant.footer, dispatch));
  container.appendChild(
    renderPageNumbering(draft.composition.pageNumbering, dispatch.onPageNumberingChange)
  );

  const previewHost = el('div', 'hf-preview-host');
  container.appendChild(previewHost);
  renderPreview(previewHost, buildPreviewModel(draft.composition, activeVariant, previewContext));

  renderActions(container, draft, hasPersistedConfig, dispatch);
}

// ── Component ────────────────────────────────────────────────────────────

/**
 * Mounts the header/footer editor into `ctx.container`. See the module doc
 * comment for the full `ctx` contract. Returns `{ refresh }`.
 */
export function initHeaderFooterEditor(ctx) {
  const { container } = ctx;
  let draft = createDraft({});
  let hasPersistedConfig = false;
  let mode = 'loading'; // 'loading' | 'empty' | 'editing' | 'error'
  let activeVariant = 'default';

  function applyEdit(newDraft) {
    draft = newDraft;
    render();
  }

  function currentField(regionKind, cellPosition, index) {
    const variant = selectVariant(draft.composition, activeVariant) ?? {};
    return variant[regionKind]?.[cellPosition]?.content?.[index];
  }

  const dispatch = {
    onVariantChange: (key) => {
      activeVariant = key;
      render();
    },
    onFieldEdit: (regionKind, cellPosition, index, field) =>
      applyEdit(editField(draft, activeVariant, regionKind, cellPosition, index, field)),
    onFieldText: (regionKind, cellPosition, index, text) => {
      const field = currentField(regionKind, cellPosition, index) ?? {};
      applyEdit(
        editField(draft, activeVariant, regionKind, cellPosition, index, { ...field, text })
      );
    },
    onFieldRemove: (regionKind, cellPosition, index) =>
      applyEdit(removeField(draft, activeVariant, regionKind, cellPosition, index)),
    onFieldAdd: (regionKind, cellPosition) =>
      applyEdit(addField(draft, activeVariant, regionKind, cellPosition, emptyField('literal'))),
    onPageNumberingChange: (pageNumbering) => applyEdit(editPageNumbering(draft, pageNumbering)),
    onSave: () => void onSave(),
    onDelete: () => void onDelete(),
  };

  function render() {
    container.replaceChildren();
    if (mode === 'loading') {
      container.appendChild(el('p', 'hf-editor-loading', 'Loading…'));
      return;
    }
    if (mode === 'error') {
      renderErrorState(container, refresh, ctx.loadErrorLabel);
      return;
    }
    if (mode === 'empty') {
      renderEmptyState(container, onCreate, ctx.emptyStateLabel);
      return;
    }
    renderEditorBody(
      container,
      { draft, activeVariant, hasPersistedConfig, previewContext: ctx.getPreviewContext?.() ?? {} },
      dispatch
    );
  }

  function onCreate() {
    draft = createDraft({});
    mode = 'editing';
    render();
  }

  async function onSave() {
    try {
      draft = await saveDraft(ctx, draft);
      hasPersistedConfig = true;
      mode = 'editing';
      ctx.toast?.('Header/footer configuration saved');
    } catch (err) {
      ctx.toast?.(`Could not save header/footer configuration: ${err.message}`, 'err');
    }
    render();
  }

  async function onDelete() {
    const ok = await openConfirm({
      title: 'Delete header/footer configuration',
      body: 'Delete this configuration? This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    let outcome;
    try {
      outcome = await deleteDraft(ctx);
    } catch (err) {
      ctx.toast?.(`Could not delete header/footer configuration: ${err.message}`, 'err');
      return;
    }
    // deleteDraft() already fired ctx.onSaved?.() — e.g. header-footer.js's
    // project-scope wiring refreshes the sibling Effective Resolution panel
    // from it — before this repaint, so the two never disagree.
    ctx.toast?.(
      outcome.alreadyRemoved
        ? 'Header/footer configuration was already removed'
        : 'Header/footer configuration deleted'
    );
    draft = outcome.draft;
    hasPersistedConfig = false;
    mode = 'empty';
    render();
  }

  async function refresh() {
    mode = 'loading';
    render();
    const outcome = await loadDraft(ctx);
    if (outcome.status === 'loaded') {
      draft = outcome.draft;
      hasPersistedConfig = true;
      mode = 'editing';
    } else if (outcome.status === 'empty') {
      draft = createDraft({});
      hasPersistedConfig = false;
      mode = 'empty';
    } else {
      // A REAL load failure (network error, 5xx, malformed envelope) — never
      // collapsed into 'empty', which would let "Create configuration" ->
      // Save fire a destructive full-composition ctx.put() over whatever is
      // actually stored (see loadDraft's doc comment). hasPersistedConfig is
      // left as whatever it last was — 'error' mode never renders Save/
      // Create/Delete, so it can't drive an overwrite either way.
      mode = 'error';
      ctx.toast?.(`Could not load header/footer configuration: ${outcome.message}`, 'err');
    }
    render();
  }

  return { refresh };
}
