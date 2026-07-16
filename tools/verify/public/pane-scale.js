// Display-mode + scale-wrapper DOM management (#506). Extracted out of
// harness.js (which had grown past this package's own tightened 400-line
// file cap — CLAUDE.md's project override, mirrored by
// src/file-line-budget.test.ts's public/ scan) into its own single-purpose
// file, matching the "many small files" convention CLAUDE.md/code.md already
// applies elsewhere in this package (e.g. scenario-picker.js split out of
// harness.js for the same reason). A thin sibling to harness.js, exactly
// like scenario-picker.js: no module system, no bundler — the two files
// communicate only by attaching to the shared global `window`, and MUST be
// loaded in index.html with this file's <script> tag BEFORE harness.js's,
// so window.__setDisplayMode/__createScaleTarget/__rescaleAllPanes already
// exist by the time harness.js's own deferred callbacks (form submit, poll
// tick, __loadPane) first reference them.
//
// Public driving-agent hooks (documented in README's "Display mode: fit vs
// capture" section): window.__setDisplayMode, window.__getDisplayMode.
// Internal cross-file wiring for harness.js's own use only — same posture
// as harness.js's own window.__pollRun/__resetPaneState exports for
// scenario-picker.js, not part of the driving-agent contract:
// window.__createScaleTarget, window.__rescaleAllPanes.
//
// DISPLAY MODES (#506): the page renders panes in one of two modes, chosen
// once at load from the `mode` query param (resolveDisplayMode) and mutable
// afterward only through window.__setDisplayMode('fit' | 'capture'). The
// mode is a single, GLOBAL switch for the whole page, not a per-pane
// setting — switching modes re-scales BOTH panes together, by design (#506
// spike finding 2), so none of resolveDisplayMode/__setDisplayMode/
// __getDisplayMode take a `pane` argument. fit (default) scales panes down
// via a NESTED .pane-scale-outer/.pane-scale-target wrapper pair
// (index.html's CSS): a single element can't simultaneously be
// docx-preview's render target, the CSS transform target, AND the sizing
// box its overflow:auto ancestor measures scrollWidth/scrollHeight against
// — transform:scale() alone never shrinks that ancestor's scroll size (#506
// spike finding 1). capture (?mode=capture) renders panes at natural,
// untransformed size — the ONLY mode harness.js's window.__measure()/
// window.__regionGeom() trust geometry against; both switch into it via
// harness.js's own withCaptureMode() for the read, then restore the caller's
// prior mode before returning (a measurement never leaves the display stuck
// in capture mode — #506 orchestrator finding).

(function () {
  'use strict';

  // Mirrors harness.js's own PANE_CONTENT_IDS exactly — duplicated rather
  // than threaded across files as a parameter, same posture as
  // scenario-picker.js's own hardcoded SCENARIO_IDS mirror (that file's own
  // comment: "this page has no endpoint to fetch the catalog from"). Only
  // two panes exist and this mapping does not change independently of
  // index.html's own markup, so the duplication is cheap and the two files
  // stay decoupled.
  var PANE_CONTENT_IDS = {
    reference: 'pane-reference-content',
    roundtrip: 'pane-roundtrip-content',
  };

  function resolveDisplayMode(search) {
    // Never throws: any query string this can't parse, or any `mode` value
    // other than exactly 'capture', falls back to the default ('fit')
    // rather than surfacing a load-time error over a cosmetic default.
    return new URLSearchParams(search).get('mode') === 'capture' ? 'capture' : 'fit';
  }

  var displayMode = resolveDisplayMode(window.location.search);

  window.__setDisplayMode = function setDisplayMode(mode) {
    if (mode !== 'fit' && mode !== 'capture') {
      throw new Error("displayMode must be 'fit' or 'capture', got: " + JSON.stringify(mode));
    }
    displayMode = mode;
    // Idempotent even when re-set to the current mode: window.__rescaleAllPanes()
    // always resets-then-recomputes (see applyDisplayModeToPane below), so
    // calling this again after e.g. a viewport resize is a legitimate way
    // to force a clean recompute, not a wasted no-op call. Always called
    // through its window.__-qualified name, never a bare local alias — the
    // same convention harness.js itself uses for its own window.__x exports
    // (e.g. tryAutoLoadPane always calls window.__loadPane(...), never a
    // bare loadPane(...)).
    window.__rescaleAllPanes();
  };

  window.__getDisplayMode = function getDisplayMode() {
    return displayMode;
  };

  // ─── scale-wrapper DOM management + fit-mode scaling math (#506 task 3/9)
  // ───────────────────────────────────────────────────────────────────────
  // A single element can't simultaneously be docx-preview's render target,
  // the CSS transform target, AND the sizing box the pane-content ancestor's
  // overflow:auto measures scrollWidth/scrollHeight against (see this file's
  // DISPLAY MODES header comment — #506 spike finding 1). So every pane
  // gets a NESTED pair: .pane-scale-outer (the sized layout box) wrapping
  // .pane-scale-target (docx-preview's actual render target, and the
  // transform target).

  function getScaleOuter(pane) {
    return document.getElementById(PANE_CONTENT_IDS[pane]).querySelector('.pane-scale-outer');
  }

  function getScaleTarget(pane) {
    var outer = getScaleOuter(pane);
    return outer ? outer.querySelector('.pane-scale-target') : null;
  }

  // Exposed for harness.js's __loadPane — rebuilds the outer/target pair
  // fresh on every call (clears the pane-content div first), which is what
  // keeps a reload from accumulating a second .pane-scale-outer/
  // .pane-scale-target pair alongside a stale one from a previous load.
  window.__createScaleTarget = function createScaleTarget(pane) {
    var container = document.getElementById(PANE_CONTENT_IDS[pane]);
    container.textContent = '';
    var outer = document.createElement('div');
    outer.className = 'pane-scale-outer';
    var target = document.createElement('div');
    target.className = 'pane-scale-target';
    outer.appendChild(target);
    container.appendChild(outer);
    return target;
  };

  function resetScalePair(outer, target) {
    outer.style.width = '';
    outer.style.height = '';
    target.style.width = '';
    target.style.transform = '';
    target.style.transformOrigin = '';
  }

  function isPositiveFinite(value) {
    return Number.isFinite(value) && value > 0;
  }

  function applyDisplayModeToPane(pane) {
    var outer = getScaleOuter(pane);
    var target = getScaleTarget(pane);
    if (!outer || !target) return undefined;

    // Always reset first — one code path for fit→capture, capture→fit, and
    // a fresh reload, so no stale transform/dimension ever survives a mode
    // switch or a recompute (this is what makes capture-mode geometry
    // byte-identical to a pane that was never transformed).
    resetScalePair(outer, target);
    if (displayMode === 'capture') return undefined;

    // width:max-content neutralizes docx-preview's own centering CSS so the
    // natural (untransformed) page size can be measured off `target` —
    // without this, a narrower ancestor would already be squeezing the page
    // before its size is ever read.
    target.style.width = 'max-content';
    var naturalRect = target.getBoundingClientRect();
    if (!isPositiveFinite(naturalRect.width) || !isPositiveFinite(naturalRect.height)) {
      resetScalePair(outer, target);
      return undefined;
    }

    var paneContentEl = document.getElementById(PANE_CONTENT_IDS[pane]);
    var rawFactor = paneContentEl.clientWidth / naturalRect.width;
    if (!isPositiveFinite(rawFactor)) {
      resetScalePair(outer, target);
      return undefined;
    }
    // Clamped to at most 1 — fit mode's documented contract (this file's
    // header comment, index.html, README) is that it SCALES PANES DOWN, never
    // up. A pane column wider than the page's natural width (e.g. the tool's
    // own recommended workflow: pinning the documented 3200px capture
    // viewport while still in default fit mode yields a pane column wider
    // than a Letter/A4 page) would otherwise produce factor > 1 and upscale.
    var factor = Math.min(rawFactor, 1);

    target.style.transform = 'scale(' + factor + ')';
    target.style.transformOrigin = 'top left';
    // The outer wrapper is the box the pane-content ancestor's overflow:auto
    // measures scrollWidth/scrollHeight against — sizing it to exactly the
    // scaled natural dimensions (not the untransformed natural size) is what
    // eliminates the stray scroll space a lone transformed element leaves
    // behind (#506 spike finding 1).
    outer.style.width = naturalRect.width * factor + 'px';
    outer.style.height = naturalRect.height * factor + 'px';
    return factor;
  }

  // Loose enough to absorb sub-pixel rounding between two independently
  // rendered panes at the same nominal page width, tight enough to still
  // flag a genuine mismatch (e.g. one pane failing to load at all).
  var SCALE_MISMATCH_EPSILON = 0.01;

  // Exposed for harness.js's __loadPane, which calls this on its own success
  // path so a freshly rendered pane's new natural size rescales both panes
  // immediately, without waiting for the next resize event.
  window.__rescaleAllPanes = function rescaleAllPanes() {
    var referenceFactor = applyDisplayModeToPane('reference');
    var roundtripFactor = applyDisplayModeToPane('roundtrip');
    var mismatched =
      referenceFactor !== undefined &&
      roundtripFactor !== undefined &&
      Math.abs(referenceFactor - roundtripFactor) > SCALE_MISMATCH_EPSILON;
    document.getElementById('fit-scale-note').textContent = mismatched
      ? 'fit-scale mismatch: reference=' +
        referenceFactor.toFixed(3) +
        ' roundtrip=' +
        roundtripFactor.toFixed(3)
      : '';
  };

  window.addEventListener('resize', window.__rescaleAllPanes);
})();
