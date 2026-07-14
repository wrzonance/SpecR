// Header/footer demo orchestrator (#477) — wires the pure/DOM-paint modules
// together into the two live scopes the v1 UI supports (client library,
// project) plus the read-only spec-inspector mount point.
//
// ctx contract (wired by app.js):
//   getSelectedLibraryTier: () => 'reference'|'company'|'client'|null — the
//     currently selected Library-view library's tier, ALREADY normalized to
//     `null` for "nothing selected" (never `undefined`) — mirrors the
//     server's requireClientLibrary gate this module's client-scope panel
//     enforces client-side.
//   getSelectedLibraryId: () => string | null
//   getActiveProjectId: () => string | null
//   libraryContainer: HTMLElement       — dedicated mount for the client-
//     scope editor (Library view). Cleared and redrawn on every refresh —
//     unlike mountInspector's target, nothing else lives in it.
//   projectEditorContainer: HTMLElement — dedicated mount for the project-
//     scope editor (Settings view).
//   projectResolutionContainer: HTMLElement — dedicated mount for the
//     Effective Resolution sub-panel (winning scope + layer chain).
//   toast?: (message, kind?) => void
//   getPreviewContext?: () => PreviewFieldContext — passed straight through
//     to the editor's own preview (date/projectName/clientName only — see
//     header-footer-preview.mjs's PREVIEWABLE_IDENTITY_KEYS).
//
// Returns `{ refreshLibraryPanel, refreshProjectPanel, mountInspector }`.
//
// SPIKE FIX (container-clearing bug): mountInspector(container, spec) mounts
// into `#editor-inspector`, which editor.js's renderInspector() has ALREADY
// populated with CITES/CITED BY/EDITABILITY before this callback runs.
// mountInspector therefore only ever APPENDS one new wrapper element — it
// must never call `container.replaceChildren()`/`innerHTML = ''`/anything
// that clears `container`. The wrapper itself is this component's own mount
// and is freely rebuilt on every call.
//
// SPIKE FIX (stale resolution panel): a project-scope Save used to leave the
// sibling Effective Resolution panel showing the pre-save layers/winning
// scope until the user switched views. `projectEditorCtx`'s `onSaved` now
// re-fetches and repaints that panel immediately, every time.
import { API_FEATURES } from './features.js';
import {
  getClientHeaderFooter,
  putClientHeaderFooter,
  deleteClientHeaderFooter,
  getProjectHeaderFooter,
  putProjectHeaderFooter,
  deleteProjectHeaderFooter,
  getProjectHeaderFooterResolved,
  fetchSpecDocx,
} from './api.js';
import { initHeaderFooterEditor } from './header-footer-editor.js';
import { winningScope, scopeLabel } from './header-footer-resolve.mjs';
import { triggerBlobDownload } from './download.js';

const defaultDeps = {
  createEditor: initHeaderFooterEditor,
  getClientHeaderFooter,
  putClientHeaderFooter,
  deleteClientHeaderFooter,
  getProjectHeaderFooter,
  putProjectHeaderFooter,
  deleteProjectHeaderFooter,
  getProjectHeaderFooterResolved,
  fetchSpecDocx,
  triggerBlobDownload,
  createElement: (tag) => document.createElement(tag),
};

// ── DOM paint helpers — real DOM painting, untested directly here (no
// jsdom); the wiring around them (which fns fire, container clear-vs-append)
// is the tested boundary, same split as header-footer-editor.js. ──

function el(deps, tag, className, text) {
  const node = deps.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A status-specific toast for a failed DOCX generation/download — distinct
// copy per failure mode so the user knows whether to retry, check the spec,
// or report a bug, rather than one generic "download failed" for everything.
function downloadFailureMessage(spec, err) {
  if (err?.status === 404) {
    return `Section ${spec.section} was not found — it may have been removed`;
  }
  if (err?.status === 400) return `Could not generate ${spec.section}.docx: ${err.message}`;
  if (err?.status === 500) {
    return `Server error generating ${spec.section}.docx — try again shortly`;
  }
  return `Could not download ${spec.section}.docx: ${err?.message ?? 'unknown error'}`;
}

async function downloadSpecDocx(spec, ctx, deps) {
  try {
    const blob = await deps.fetchSpecDocx(spec.id);
    deps.triggerBlobDownload(blob, `${spec.section}.docx`);
    ctx.toast?.(`Downloaded ${spec.section}.docx`);
  } catch (err) {
    ctx.toast?.(downloadFailureMessage(spec, err), 'err');
  }
}

function paintInspectorPanel(wrapper, spec, ctx, deps) {
  wrapper.appendChild(el(deps, 'div', 'hf-inspector-head', 'HEADER / FOOTER'));
  const download = el(deps, 'button', 'hf-inspector-download', 'Download DOCX');
  download.type = 'button';
  download.title = 'Generate this section as a DOCX with its configured header/footer';
  download.addEventListener('click', () => void downloadSpecDocx(spec, ctx, deps));
  wrapper.appendChild(download);
}

// Repaints (never appends-only — this is a dedicated sub-panel mount, unlike
// mountInspector's target) the winning-scope badge + full layer chain.
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

export function initHeaderFooter(ctx, deps = defaultDeps) {
  let clientEditor = null;
  let projectEditor = null;

  function previewContext() {
    return ctx.getPreviewContext ? ctx.getPreviewContext() : undefined;
  }

  function clientEditorCtx() {
    return {
      container: ctx.libraryContainer,
      get: () => deps.getClientHeaderFooter(ctx.getSelectedLibraryId()),
      put: (composition) => deps.putClientHeaderFooter(ctx.getSelectedLibraryId(), composition),
      del: () => deps.deleteClientHeaderFooter(ctx.getSelectedLibraryId()),
      toast: ctx.toast,
      previewContext: previewContext(),
      emptyStateLabel: 'No header/footer configuration for this client library yet.',
    };
  }

  function projectEditorCtx() {
    return {
      container: ctx.projectEditorContainer,
      get: () => deps.getProjectHeaderFooter(ctx.getActiveProjectId()),
      put: (composition) => deps.putProjectHeaderFooter(ctx.getActiveProjectId(), composition),
      del: () => deps.deleteProjectHeaderFooter(ctx.getActiveProjectId()),
      toast: ctx.toast,
      previewContext: previewContext(),
      // Fires AFTER ctx.put resolves (saveDraft's contract) and BEFORE the
      // editor's own repaint — see the module doc's stale-panel spike fix.
      onSaved: () => refreshResolutionPanel(),
      emptyStateLabel: 'No header/footer configuration for this project yet.',
    };
  }

  async function refreshResolutionPanel() {
    const projectId = ctx.getActiveProjectId();
    if (!API_FEATURES.headerFooter || !projectId) {
      ctx.projectResolutionContainer.replaceChildren();
      return;
    }
    try {
      const resolved = await deps.getProjectHeaderFooterResolved(projectId);
      paintResolutionPanel(ctx.projectResolutionContainer, resolved, deps);
    } catch (err) {
      ctx.toast?.(`Could not load effective header/footer resolution: ${err.message}`, 'err');
    }
  }

  // Client-scope panel (Library view) — visible ONLY for tier === 'client',
  // mirroring the server's requireClientLibrary gate (a company/reference
  // library has no client-scope row to configure, and the API 400s on one).
  // The editor is created lazily and ONLY inside this branch, so ctx.get()
  // (and therefore the network call) never fires for a non-client tier.
  async function refreshLibraryPanel() {
    const visible = API_FEATURES.headerFooter && ctx.getSelectedLibraryTier() === 'client';
    if (!visible) {
      ctx.libraryContainer.replaceChildren();
      clientEditor = null;
      return;
    }
    if (!clientEditor) clientEditor = deps.createEditor(clientEditorCtx());
    await clientEditor.refresh();
  }

  // Project-scope panel (Settings view) — editor + Effective Resolution,
  // refreshed together so the two never disagree on load.
  async function refreshProjectPanel() {
    const visible = API_FEATURES.headerFooter && Boolean(ctx.getActiveProjectId());
    if (!visible) {
      ctx.projectEditorContainer.replaceChildren();
      ctx.projectResolutionContainer.replaceChildren();
      projectEditor = null;
      return;
    }
    if (!projectEditor) projectEditor = deps.createEditor(projectEditorCtx());
    await Promise.all([projectEditor.refresh(), refreshResolutionPanel()]);
  }

  // Mounts the read-only header/footer summary + Download DOCX action into
  // the section inspector. See the module doc's SPIKE FIX note: `container`
  // (`#editor-inspector`) already holds CITES/CITED BY/EDITABILITY — this
  // NEVER clears it, only appends its own wrapper.
  function mountInspector(container, spec) {
    if (!API_FEATURES.headerFooter) return null;
    const wrapper = el(deps, 'div', 'hf-inspector');
    container.appendChild(wrapper);
    paintInspectorPanel(wrapper, spec, ctx, deps);
    return wrapper;
  }

  return { refreshLibraryPanel, refreshProjectPanel, mountInspector };
}
