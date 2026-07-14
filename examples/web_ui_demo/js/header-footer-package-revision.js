// Package/revision header-footer demo orchestrator (#481) — mirrors
// header-footer.js's client/project wiring for the design-package and
// revision scopes of ADR-040's client -> project -> package -> revision
// precedence chain. A new sibling file, not an addition to header-footer.js
// (that file already sits at 297 lines, focused on client + project +
// inspector — code.md's many-small-files guidance).
//
// ctx contract (wired by app.js in a later task):
//   getSelectedPackageId: () => string | null — the demo's package-scope
//     UUID input, ALREADY normalized to null for "nothing entered" (never
//     '' — mirrors header-footer.js's getSelectedLibraryTier normalization).
//   getSelectedRevisionId: () => string | null — same, for the revision-scope
//     UUID input. Independent of getSelectedPackageId: a revision can be
//     inspected without its owning package ever being entered.
//   packageEditorContainer / revisionEditorContainer: HTMLElement —
//     dedicated mounts for each scope's editor (initHeaderFooterEditor),
//     never shared between scopes.
//   packageResolutionContainer / revisionResolutionContainer: HTMLElement —
//     dedicated mounts for each scope's Effective Resolution sub-panel
//     (winning scope + full layer chain — same shape as header-footer.js's
//     project-scope panel).
//   revisionDownloadContainer: HTMLElement — dedicated mount for the
//     revision-scope Download DOCX button. Package scope has NO equivalent
//     control: there is no POST /packages/:id/generate route (only
//     project-level manual and revision-level generation exist), so the
//     package panel is CRUD-only.
//   toast?: (message, kind?) => void
//   getPreviewContext?: () => PreviewFieldContext — same live-function
//     contract as header-footer.js's ctx.getPreviewContext (see that
//     module's STALE-PREVIEW FIX note); threaded through unchanged.
//
// Returns `{ refreshPackagePanel, refreshRevisionPanel }`.
//
// MANDATORY INVARIANT (spike-proven, not just a design preference):
// packageResolutionGuard and revisionResolutionGuard below are TWO SEPARATE
// createRequestGuard() instances. A single guard shared across both scopes
// breaks on ORDINARY use, not just adversarial timing: the instant
// refreshPackagePanel and refreshRevisionPanel both fire in the same tick
// (e.g. page load with both UUID inputs pre-filled), whichever scope's
// resolution fetch calls guard.next() SECOND bumps the shared counter and
// silently invalidates the FIRST scope's still-legitimate in-flight token —
// its response is dropped even though nothing about that scope's own
// selection changed. See header-footer-package-revision.test.mjs's dedicated
// same-tick regression test.
import { API_FEATURES } from './features.js';
import {
  getPackageHeaderFooter,
  putPackageHeaderFooter,
  deletePackageHeaderFooter,
  getPackageHeaderFooterResolved,
  getRevisionHeaderFooter,
  putRevisionHeaderFooter,
  deleteRevisionHeaderFooter,
  getRevisionHeaderFooterResolved,
  fetchRevisionDocx,
} from './api.js';
import { initHeaderFooterEditor } from './header-footer-editor.js';
import { winningScope, scopeLabel } from './header-footer-resolve.mjs';
import { triggerBlobDownload } from './download.js';
import { createRequestGuard } from './request-guard.mjs';

const defaultDeps = {
  createEditor: initHeaderFooterEditor,
  getPackageHeaderFooter,
  putPackageHeaderFooter,
  deletePackageHeaderFooter,
  getPackageHeaderFooterResolved,
  getRevisionHeaderFooter,
  putRevisionHeaderFooter,
  deleteRevisionHeaderFooter,
  getRevisionHeaderFooterResolved,
  fetchRevisionDocx,
  triggerBlobDownload,
  createElement: (tag) => document.createElement(tag),
};

// ── DOM paint helpers — real DOM painting, untested directly here (no
// jsdom); the wiring around them is the tested boundary, same split as
// header-footer.js. ──

function el(deps, tag, className, text) {
  const node = deps.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// See header-footer.js's identical helper: getPackageHeaderFooter/
// getRevisionHeaderFooter (and their put counterparts) resolve the FULL
// stored record (`{ id, scope, config, createdAt, updatedAt }`); the
// editor's ctx.get/ctx.put contract wants the bare HeaderFooterComposition.
// Unwrap once here, rather than leaking the API envelope into the editor.
function unwrapComposition(record) {
  return record?.config ?? null;
}

// A status-specific toast for a failed revision DOCX generation/download —
// mirrors header-footer.js's downloadFailureMessage exactly, scoped to a
// revisionId instead of a spec section.
function downloadFailureMessage(revisionId, err) {
  if (err?.status === 404) {
    return `Revision ${revisionId} was not found — it may have been removed`;
  }
  if (err?.status === 400) return `Could not generate the revision DOCX: ${err.message}`;
  if (err?.status === 500) {
    return `Server error generating the revision DOCX (${revisionId}) — try again shortly`;
  }
  return `Could not download the revision DOCX (${revisionId}): ${err?.message ?? 'unknown error'}`;
}

async function downloadRevisionDocx(revisionId, ctx, deps) {
  try {
    const blob = await deps.fetchRevisionDocx(revisionId);
    deps.triggerBlobDownload(blob, `revision-${revisionId}.docx`);
    ctx.toast?.('Downloaded revision DOCX');
  } catch (err) {
    ctx.toast?.(downloadFailureMessage(revisionId, err), 'err');
  }
}

function paintDownloadButton(container, revisionId, ctx, deps) {
  container.replaceChildren();
  const button = el(deps, 'button', 'hf-revision-download', 'Download DOCX');
  button.type = 'button';
  button.title = 'Generate this revision as a DOCX with its configured header/footer';
  button.addEventListener('click', () => void downloadRevisionDocx(revisionId, ctx, deps));
  container.appendChild(button);
}

// Repaints (never appends-only) the winning-scope badge + full layer chain —
// same shape as header-footer.js's paintResolutionPanel, duplicated locally
// rather than imported: each file owns its own DOM-paint helpers by this
// codebase's existing convention (see header-footer.js vs.
// header-footer-editor.js's independent `el()` helpers).
function paintResolutionPanel(container, resolved, deps) {
  container.replaceChildren();
  const layers = Array.isArray(resolved?.layers) ? resolved.layers : [];
  const wrap = el(deps, 'div', 'hf-resolution');
  wrap.appendChild(
    el(deps, 'div', 'hf-resolution-winner', `Winning scope: ${scopeLabel(winningScope(layers))}`)
  );
  if (layers.length > 0) {
    const chain = el(deps, 'div', 'hf-resolution-chain');
    for (const layer of layers) {
      chain.appendChild(el(deps, 'span', 'hf-resolution-layer', scopeLabel(layer.scope)));
    }
    wrap.appendChild(chain);
  }
  container.appendChild(wrap);
}

export function initPackageRevisionHeaderFooter(ctx, deps = defaultDeps) {
  let packageEditor = null;
  let revisionEditor = null;
  // MANDATORY: independent guards — see the module doc's invariant note.
  const packageResolutionGuard = createRequestGuard();
  const revisionResolutionGuard = createRequestGuard();

  function previewContext() {
    return ctx.getPreviewContext ? ctx.getPreviewContext() : undefined;
  }

  async function refreshPackageResolutionPanel() {
    const token = packageResolutionGuard.next();
    const packageId = ctx.getSelectedPackageId();
    if (!API_FEATURES.headerFooter || !packageId) {
      ctx.packageResolutionContainer.replaceChildren();
      return;
    }
    try {
      const resolved = await deps.getPackageHeaderFooterResolved(packageId);
      if (!packageResolutionGuard.isCurrent(token)) return; // superseded
      paintResolutionPanel(ctx.packageResolutionContainer, resolved, deps);
    } catch (err) {
      if (!packageResolutionGuard.isCurrent(token)) return;
      ctx.toast?.(`Could not load effective header/footer resolution: ${err.message}`, 'err');
    }
  }

  async function refreshRevisionResolutionPanel() {
    const token = revisionResolutionGuard.next();
    const revisionId = ctx.getSelectedRevisionId();
    if (!API_FEATURES.headerFooter || !revisionId) {
      ctx.revisionResolutionContainer.replaceChildren();
      return;
    }
    try {
      const resolved = await deps.getRevisionHeaderFooterResolved(revisionId);
      if (!revisionResolutionGuard.isCurrent(token)) return; // superseded
      paintResolutionPanel(ctx.revisionResolutionContainer, resolved, deps);
    } catch (err) {
      if (!revisionResolutionGuard.isCurrent(token)) return;
      ctx.toast?.(`Could not load effective header/footer resolution: ${err.message}`, 'err');
    }
  }

  function packageEditorCtx() {
    return {
      container: ctx.packageEditorContainer,
      get: async () =>
        unwrapComposition(await deps.getPackageHeaderFooter(ctx.getSelectedPackageId())),
      put: async (composition) =>
        unwrapComposition(
          await deps.putPackageHeaderFooter(ctx.getSelectedPackageId(), composition)
        ),
      del: () => deps.deletePackageHeaderFooter(ctx.getSelectedPackageId()),
      toast: ctx.toast,
      getPreviewContext: previewContext,
      // See header-footer.js's projectEditorCtx: fires AFTER ctx.put
      // resolves and BEFORE the editor's own repaint — never touches the
      // revision scope's resolution panel.
      onSaved: () => refreshPackageResolutionPanel(),
      emptyStateLabel: 'No header/footer configuration for this design package yet.',
    };
  }

  function revisionEditorCtx() {
    return {
      container: ctx.revisionEditorContainer,
      get: async () =>
        unwrapComposition(await deps.getRevisionHeaderFooter(ctx.getSelectedRevisionId())),
      put: async (composition) =>
        unwrapComposition(
          await deps.putRevisionHeaderFooter(ctx.getSelectedRevisionId(), composition)
        ),
      del: () => deps.deleteRevisionHeaderFooter(ctx.getSelectedRevisionId()),
      toast: ctx.toast,
      getPreviewContext: previewContext,
      onSaved: () => refreshRevisionResolutionPanel(),
      emptyStateLabel: 'No header/footer configuration for this revision yet.',
    };
  }

  // Package-scope panel — editor + Effective Resolution, no Download DOCX
  // (no generate route exists for a bare package — see the module doc).
  async function refreshPackagePanel() {
    const visible = API_FEATURES.headerFooter && Boolean(ctx.getSelectedPackageId());
    if (!visible) {
      // Tear down the resolution guard BEFORE clearing so an in-flight
      // refreshPackageResolutionPanel() fetch settling after this deselect is
      // dropped by its isCurrent(token) check — otherwise it would repaint
      // stale package data into the just-cleared container. bump() (not next())
      // is the guard's documented teardown call: invalidate in-flight without
      // issuing a new token, since nothing is selected anymore.
      packageResolutionGuard.bump();
      ctx.packageEditorContainer.replaceChildren();
      ctx.packageResolutionContainer.replaceChildren();
      // Invalidate BEFORE dropping the reference — see header-footer.js's
      // matching comment on refreshProjectPanel for why.
      packageEditor?.invalidate?.();
      packageEditor = null;
      return;
    }
    if (!packageEditor) packageEditor = deps.createEditor(packageEditorCtx());
    await Promise.all([packageEditor.refresh(), refreshPackageResolutionPanel()]);
  }

  // Revision-scope panel — editor + Effective Resolution + Download DOCX,
  // refreshed together so none of the three ever disagree on load.
  async function refreshRevisionPanel() {
    const revisionId = ctx.getSelectedRevisionId();
    const visible = API_FEATURES.headerFooter && Boolean(revisionId);
    if (!visible) {
      // See refreshPackagePanel: tear down the guard first (bump()) so a late
      // resolution response can't repaint the just-cleared revision container.
      revisionResolutionGuard.bump();
      ctx.revisionEditorContainer.replaceChildren();
      ctx.revisionResolutionContainer.replaceChildren();
      ctx.revisionDownloadContainer.replaceChildren();
      revisionEditor?.invalidate?.();
      revisionEditor = null;
      return;
    }
    if (!revisionEditor) revisionEditor = deps.createEditor(revisionEditorCtx());
    paintDownloadButton(ctx.revisionDownloadContainer, revisionId, ctx, deps);
    await Promise.all([revisionEditor.refresh(), refreshRevisionResolutionPanel()]);
  }

  return { refreshPackagePanel, refreshRevisionPanel };
}
