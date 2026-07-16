// Browser-side harness page for the visual round-trip verification tool
// (#150, task 7/8). Plain global script (no bundler, no module system) —
// loaded via <script> tag after the docx-preview/jszip UMD bundles, exactly
// like the WT-150 spike's spike-web/index.html this file is adapted from.
// window.__loadPane / window.__measure / window.__regionGeom are exposed on
// `window` so an external Playwright-driven agent can call them directly via
// page.evaluate() — that agent is this tool's only "user".
//
// LOCKED RENDER OPTIONS (design decision 7 — flow-mode rendering): both
// panes always render with ignoreLastRenderedPageBreak: true. The Q1 spike
// measured that identical content renders as 12 pages (marked, Word-saved
// reference) vs 1 page (unmarked, generator output) unless this is forced —
// forcing it produces byte-identical flow layout on both sides. This is no
// longer the spike's query-string toggle; it is not configurable from this
// page at all.
//
// CAPTURE PATH (design decision 2 — resolved, not left open): an in-page
// canvas/foreignObject rasterization of the rendered panes was prototyped by
// the WT-150 spike and confirmed non-viable (blank/gray output — the
// injected docx-preview stylesheet does not survive a cloned-subtree
// foreignObject rasterization in Chromium). It is intentionally NOT shipped
// here, working or otherwise. The only capture path is external: the driving
// agent (Playwright) resizes the viewport, takes a full-page screenshot of
// this document, and POSTs it as base64 PNG to
// POST /api/runs/:runId/screenshot (see server/routes/runs.ts).
//
// VIEWPORT PRECONDITION (design decision 3 — WT-150 spike finding 2):
// window.__measure()'s geometry is getBoundingClientRect()-based, i.e.
// VIEWPORT-RELATIVE, not document-relative. Before taking any screenshot the
// driving agent MUST resize the viewport to >= __harnessConfig.viewportWidth
// and scroll to the top of the page, or captured x/y can be negative
// (docx-preview centers the page in a narrower viewport). render/regions.ts's
// cropRegion() bounds-check is a backstop for a missed precondition, not the
// primary guard.
//
// DISPLAY MODES (#506): the page renders panes in one of two modes, chosen
// once at load from the `mode` query param and mutable afterward only
// through window.__setDisplayMode('fit' | 'capture'). The mode is a single,
// GLOBAL switch for the whole page, not a per-pane setting — switching
// modes re-scales BOTH panes together, by design (#506 spike finding 2).
// fit (default) scales panes down via a NESTED .pane-scale-outer/
// .pane-scale-target wrapper pair (index.html's CSS): a single element
// can't simultaneously be docx-preview's render target, the CSS transform
// target, AND the sizing box its overflow:auto ancestor measures
// scrollWidth/scrollHeight against — transform:scale() alone never shrinks
// that ancestor's scroll size (#506 spike finding 1). capture
// (?mode=capture) renders panes at natural, untransformed size — the ONLY
// mode window.__measure()/window.__regionGeom() trust geometry against;
// both switch into it via withCaptureMode() for the read and restore the
// caller's prior mode before returning, so a measurement never leaves the
// human-facing display stuck in capture mode (#506 orchestrator finding).
//
// All of the above — mode storage/validation, and the scale-wrapper DOM
// management/math that applies it (getScaleOuter/getScaleTarget/
// createScaleTarget/rescaleAllPanes) — lives in the sibling file
// pane-scale.js, not here: harness.js had grown past this package's own
// 400-line file cap (CLAUDE.md's project override), so that self-contained
// concern was extracted, the same way scenario-picker.js was split out of
// this file earlier. index.html loads pane-scale.js's <script> tag BEFORE
// this one so window.__setDisplayMode/__createScaleTarget/__rescaleAllPanes
// already exist by the time this file's own deferred callbacks (form
// submit, poll tick, __loadPane) first reference them.

(function () {
  'use strict';

  // Hardcoded, mirrors config.ts's VerifyEnv.viewportWidth default (3200) —
  // this task's scope is the frontend page only, so there is no backend
  // config endpoint to fetch this from yet. The driving agent reads this
  // constant instead of a hardcoded number duplicated in its own script.
  // 3200, not 900: this page's 3-column pane grid (see index.html) needs a
  // viewport wide enough that BOTH the reference and round-trip panes fit
  // their full rendered page width (Letter/A4, up to 816px) without
  // docx-preview's centering pushing pageGeom.x negative — see config.ts's
  // VerifyEnv.viewportWidth docstring for the measured threshold.
  window.__harnessConfig = Object.freeze({ viewportWidth: 3200 });

  const RENDER_OPTIONS = {
    breakPages: true,
    renderHeaders: true,
    renderFooters: true,
    ignoreLastRenderedPageBreak: true,
    experimental: true,
    inWrapper: true,
    useBase64URL: true,
  };

  const PANE_CONTENT_IDS = {
    reference: 'pane-reference-content',
    roundtrip: 'pane-roundtrip-content',
  };

  const PANE_FILENAMES = {
    reference: 'reference.docx',
    roundtrip: 'generated.docx',
  };

  const paneState = {
    reference: { status: 'idle', error: null },
    roundtrip: { status: 'idle', error: null },
  };

  // ─── small DOM helpers (textContent only — never innerHTML with
  // interpolated data; derivation-report values originate from a
  // user-uploaded, untrusted DOCX) ─────────────────────────────────────────

  function el(tag, options) {
    const node = document.createElement(tag);
    if (options && options.className) node.className = options.className;
    if (options && options.text !== undefined) node.textContent = options.text;
    return node;
  }

  function clearChildren(node) {
    node.textContent = '';
  }

  // ─── pane loading (window.__loadPane) ──────────────────────────────────
  // Scale-wrapper DOM management (window.__createScaleTarget) and fit-mode
  // rescaling (window.__rescaleAllPanes) live in the sibling pane-scale.js
  // — see this file's header comment.

  function fetchPaneBlob(runId, pane) {
    const url = `/api/runs/${encodeURIComponent(runId)}/files/${PANE_FILENAMES[pane]}`;
    return fetch(url).then((response) => {
      if (response.ok) return response.blob();
      const err = new Error(`pane file not ready (HTTP ${String(response.status)})`);
      err.notReady = response.status === 404;
      throw err;
    });
  }

  // Bumped on every __loadPane call for a given pane — lets a call's own
  // .then()/.catch() tell whether it is still the LATEST in-flight load for
  // that pane once its fetch/render finally settles. Without this, two
  // concurrent __loadPane calls for the SAME pane (a legitimate direct
  // page.evaluate() pattern — see this file's header comment and README
  // step 3) can race: window.__createScaleTarget always detaches whatever
  // the PREVIOUS call rendered into, but nothing stopped that previous
  // call's own completion handler from still overwriting paneState with its
  // own (now-superseded) outcome once its fetch/render eventually settled —
  // even reporting a false 'done' over a genuine 'error' the newer call
  // already surfaced, silently masking a real render failure.
  const paneLoadGeneration = { reference: 0, roundtrip: 0 };

  window.__loadPane = function loadPane(runId, pane) {
    // window.__createScaleTarget rebuilds the outer/target pair fresh on
    // every call (clears the pane-content div first) — this is what keeps a
    // reload from accumulating a second .pane-scale-outer/.pane-scale-target
    // pair alongside a stale one from a previous load.
    const target = window.__createScaleTarget(pane);
    paneState[pane] = { status: 'loading', error: null };
    const generation = ++paneLoadGeneration[pane];
    return fetchPaneBlob(runId, pane)
      .then((blob) => docx.renderAsync(blob, target, null, RENDER_OPTIONS))
      .then(() => {
        // A newer __loadPane call for this pane has already started (and
        // already rebuilt the DOM target and paneState) — this call is
        // stale. Its own promise still resolves normally to its own
        // caller (the render genuinely succeeded, just into a now-detached
        // node), but it must not clobber the current, live paneState.
        if (paneLoadGeneration[pane] !== generation) return;
        paneState[pane] = { status: 'done', error: null };
        // The freshly rendered pane has a new natural size — rescale both
        // panes now so a mismatched pair doesn't sit unscaled/mis-scaled
        // until the next resize event or explicit __setDisplayMode call.
        window.__rescaleAllPanes();
      })
      .catch((err) => {
        // Same staleness guard as the success path — a superseded call's
        // failure must not overwrite a newer call's (possibly successful)
        // paneState. The rejection itself still propagates to this call's
        // own caller either way.
        if (paneLoadGeneration[pane] === generation) {
          paneState[pane] = { status: 'error', error: String((err && err.message) || err) };
        }
        throw err;
      });
  };

  function tryAutoLoadPane(runId, pane) {
    if (paneState[pane].status !== 'idle') return;
    // __loadPane bumps paneLoadGeneration[pane] synchronously (before it
    // returns the promise), so reading it right after the call captures THIS
    // load's generation.
    const loadPromise = window.__loadPane(runId, pane);
    const generation = paneLoadGeneration[pane];
    loadPromise.catch((err) => {
      // A 404 just means the pipeline hasn't produced this file yet — reset
      // to 'idle' so the next poll tick retries. Any other failure is a real
      // render error and stays surfaced via paneState[pane].error. The
      // generation guard stops a STALE load's 404 — one a newer __loadPane or
      // a resetPaneState has already superseded — from resetting that newer
      // load's 'done'/'error'/'loading' back to 'idle' (which would drop a
      // real result or spawn a redundant reload). The guard inside __loadPane
      // covers its own 'done'/'error' writes; this covers the notReady reset,
      // which lives out here in the caller and would otherwise bypass it.
      if (err && err.notReady && paneLoadGeneration[pane] === generation) {
        paneState[pane] = { status: 'idle', error: null };
      }
    });
  }

  function resetPaneState() {
    paneState.reference = { status: 'idle', error: null };
    paneState.roundtrip = { status: 'idle', error: null };
    // Invalidate any in-flight load from the just-superseded run: bumping the
    // generation makes each pending __loadPane's own guards (and
    // tryAutoLoadPane's notReady reset) see a mismatch, so a load that settles
    // AFTER this reset can't clobber the new run's fresh 'idle' with a stale
    // 'done'/'error' — which would otherwise leave the new run's pane
    // permanently blank (its status stuck non-'idle', so tryAutoLoadPane never
    // reloads it).
    paneLoadGeneration.reference += 1;
    paneLoadGeneration.roundtrip += 1;
    clearChildren(document.getElementById(PANE_CONTENT_IDS.reference));
    clearChildren(document.getElementById(PANE_CONTENT_IDS.roundtrip));
    // A stale mismatch note from a prior run must not linger over a new
    // one's panes before they've even had a chance to be measured again.
    document.getElementById('fit-scale-note').textContent = '';
  }

  // ─── geometry (window.__measure / window.__regionGeom) ────────────────
  // Field names (x/y/width/height, pageGeom/headerGeom/footerGeom) match
  // render/regions.ts's Geom and diff/pixel-diff.ts's RegionDiffInput
  // exactly, so a driving agent can feed this output straight into that
  // pipeline without reshaping it.

  // window.__measure()/window.__regionGeom() only trust geometry read in
  // capture mode (untransformed, natural size) — see this file's DISPLAY
  // MODES header comment (#506 spike finding 1: a fit-mode scale transform
  // leaves getBoundingClientRect() reporting the SCALED, not natural, size).
  // Switch-and-restore, run around `read`: snapshot the current mode, switch
  // to capture only if needed, take the measurement, then restore the prior
  // mode before returning — synchronously, so a caller that left the page in
  // 'fit' still reads 'fit' (and sees both panes still scaled) the instant
  // __measure returns. This closes off an entire class of "forgot to switch
  // modes before measuring" bugs WITHOUT the transparent switch permanently
  // degrading the human-facing display: a measurement must never leave the
  // page stuck in capture mode (#506 orchestrator finding). Global (both
  // panes), not per-pane, at BOTH ends: __setDisplayMode has no per-pane
  // variant by design (#506 spike finding 2). A pure no-op when already in
  // capture mode — skipping the switch AND the restore avoids an unnecessary
  // rescaleAllPanes() recompute on every single measurement (__setDisplayMode
  // is itself always safe to call again — task 2/9's own idempotence pin —
  // but the redundant recompute is wasted work). `read` runs synchronously so
  // its geometry is captured in capture mode before the finally restores.
  function withCaptureMode(read) {
    const priorMode = window.__getDisplayMode();
    if (priorMode !== 'capture') {
      window.__setDisplayMode('capture');
    }
    try {
      return read();
    } finally {
      if (priorMode !== 'capture') {
        window.__setDisplayMode(priorMode);
      }
    }
  }

  function geomOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  }

  function measurePage(section) {
    const header = section.querySelector('header');
    const footer = section.querySelector('footer');
    return {
      pageGeom: geomOf(section),
      headerGeom: header ? geomOf(header) : null,
      footerGeom: footer ? geomOf(footer) : null,
    };
  }

  window.__measure = function measure(pane) {
    return withCaptureMode(function () {
      const container = document.getElementById(PANE_CONTENT_IDS[pane]);
      const sections = Array.prototype.slice.call(
        container.querySelectorAll('.docx-wrapper > section.docx')
      );
      return {
        status: paneState[pane].status,
        error: paneState[pane].error,
        pageCount: sections.length,
        pages: sections.map(measurePage),
      };
    });
  };

  window.__regionGeom = function regionGeom(pane, region, pageIndex) {
    const measurement = window.__measure(pane);
    const page = measurement.pages[pageIndex || 0];
    if (!page) return null;
    if (region === 'page') return page.pageGeom;
    if (region === 'header') return page.headerGeom;
    if (region === 'footer') return page.footerGeom;
    return null;
  };

  // ─── diff pane (best-effort — the region-diff pipeline runs outside this
  // task's scope; this just displays whatever crops already exist) ───────

  const DIFF_REGIONS = ['page', 'header', 'footer'];

  function fetchDiffBlob(runId, region) {
    const url = `/api/runs/${encodeURIComponent(runId)}/files/${region}-diff.png`;
    return fetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => ({ region: region, blob: blob }));
  }

  function renderDiffResults(container, available) {
    clearChildren(container);
    if (available.length === 0) {
      container.appendChild(
        el('p', {
          className: 'pane-empty',
          text: 'No region diffs yet — capture both panes and diff them first.',
        })
      );
      return;
    }
    available.forEach(function (result) {
      container.appendChild(el('h3', { text: result.region }));
      const img = document.createElement('img');
      img.className = 'diff-image';
      img.alt = result.region + ' diff';
      img.src = URL.createObjectURL(result.blob);
      container.appendChild(img);
    });
  }

  window.__loadDiffPane = function loadDiffPane(runId) {
    const container = document.getElementById('pane-diff-content');
    return Promise.all(DIFF_REGIONS.map((region) => fetchDiffBlob(runId, region))).then(
      (results) => {
        renderDiffResults(
          container,
          results.filter((result) => result.blob !== null)
        );
      }
    );
  };

  // ─── properties sidebar + derivation-report panel (both read the same
  // DerivationReport — the sidebar shows WHAT was applied, the report panel
  // shows WHY, per issue #150 design decision 9) ──────────────────────────

  // A fixture scenario run (#305's scenario-picker.js) has no derivation
  // report to show — it never goes through the AST-derivation pipeline an
  // uploaded file does — so its empty state reads differently from a
  // genuinely-not-ready-yet upload run. RunKind is a plain caller-supplied
  // value, never validated against an enum here: anything other than
  // exactly 'scenario' falls back to the upload message rather than
  // throwing, so an unexpected value can never crash rendering (#506).
  function emptyStateMessage(runKind) {
    return runKind === 'scenario' ? 'n/a for fixture scenario runs' : 'No derivation report yet.';
  }

  function renderPropertiesGroup(nodeType) {
    const group = el('div', { className: 'node-type-group' });
    group.appendChild(
      el('h3', {
        text:
          nodeType.nodeType +
          ' (' +
          String(nodeType.styledCount) +
          '/' +
          String(nodeType.paragraphCount) +
          ' styled)',
      })
    );
    nodeType.decisions.forEach(function (decision) {
      group.appendChild(
        el('div', {
          className: 'property-row',
          text: decision.path + ' = ' + JSON.stringify(decision.value),
        })
      );
    });
    return group;
  }

  function renderProperties(report, runKind) {
    const body = document.getElementById('properties-body');
    clearChildren(body);
    if (!report) {
      body.appendChild(el('p', { className: 'pane-empty', text: emptyStateMessage(runKind) }));
      return;
    }
    report.nodeTypes.forEach(function (nodeType) {
      body.appendChild(renderPropertiesGroup(nodeType));
    });
  }

  function renderDecisionRow(decision) {
    const wrapper = el('div');
    wrapper.appendChild(
      el('div', {
        className: decision.disagreesWithIntent ? 'decision-row conflict' : 'decision-row',
        text:
          decision.path +
          ': source=' +
          decision.source +
          ' confidence=' +
          decision.confidence.toFixed(2) +
          (decision.disagreesWithIntent ? ' (disagrees with intent)' : ''),
      })
    );
    decision.rejected.forEach(function (rejected) {
      wrapper.appendChild(
        el('div', {
          className: 'rejected-row',
          text: 'rejected: ' + JSON.stringify(rejected.value) + ' x' + String(rejected.count),
        })
      );
    });
    return wrapper;
  }

  function renderDerivationReport(report, runKind) {
    const body = document.getElementById('derivation-body');
    clearChildren(body);
    if (!report) {
      body.appendChild(el('p', { className: 'pane-empty', text: emptyStateMessage(runKind) }));
      return;
    }
    body.appendChild(
      el('div', {
        className: 'property-row',
        text: 'vanish-skipped paragraphs: ' + String(report.vanishSkipped),
      })
    );
    if (report.skippedNodeTypes.length > 0) {
      body.appendChild(
        el('div', {
          className: 'property-row',
          text: 'skipped node types: ' + report.skippedNodeTypes.join(', '),
        })
      );
    }
    report.nodeTypes.forEach(function (nodeType) {
      const group = el('div', { className: 'node-type-group' });
      group.appendChild(el('h3', { text: nodeType.nodeType }));
      nodeType.decisions.forEach(function (decision) {
        group.appendChild(renderDecisionRow(decision));
      });
      body.appendChild(group);
    });
  }

  // ─── run lifecycle: start + poll GET /api/runs/:runId ──────────────────

  const POLL_INTERVAL_MS = 1000;
  // A run is terminal on failure, or when it completes at the LAST stage it
  // will reach. The upload pipeline stops at 'generate'; the header/footer
  // restartPerSpec fixture appends a 'report'-stage page-numbering
  // postcondition after generate, so 'report/complete' is terminal too (and
  // 'generate/complete' is never observed for that run — it re-opens to
  // 'report/running' synchronously). 'report' is RUN_STAGES' final stage, so
  // a complete there is always terminal.
  const TERMINAL_STAGES = ['generate', 'report'];

  function isTerminal(record) {
    return (
      record.status === 'failed' ||
      (record.status === 'complete' && TERMINAL_STAGES.indexOf(record.stage) !== -1)
    );
  }

  function renderRunStatus(record) {
    const status = document.getElementById('run-status');
    let text = record.runId + ' — stage=' + record.stage + ' status=' + record.status;
    if (record.error) text += ' — ' + record.error.message;
    status.textContent = text;
  }

  function pollOnce(runId) {
    return fetch('/api/runs/' + encodeURIComponent(runId))
      .then((response) => {
        // Throw on a non-2xx so a persistent 5xx/404 surfaces via tick()'s
        // .catch (below) instead of resolving to null and looping silently.
        if (!response.ok) throw new Error('poll failed (HTTP ' + String(response.status) + ')');
        return response.json();
      })
      .then((body) => (body ? body.data : null));
  }

  // The stopper for the currently-active poll loop, if any. Starting a new
  // run (from the upload form OR scenario-picker.js, both of which call
  // pollRun) supersedes the previous loop so two pollers never write to
  // #run-status and the panes at once — a stale run can't overwrite a newer
  // one's result. __resetPaneState only clears the panes; it does not stop
  // an in-flight loop, which is why the guard lives here.
  let activeStop = null;
  function pollRun(runId, runKind = 'upload') {
    // A plain per-call argument, never persisted module state — each call
    // to pollRun (upload form vs. scenario-picker.js) supplies its own
    // runKind, closure-captured by THIS call's tick(), so an earlier run's
    // runKind can never leak into a later, unrelated one.
    if (activeStop) activeStop();
    let stopped = false;
    activeStop = function () {
      stopped = true;
    };
    function tick() {
      if (stopped) return;
      pollOnce(runId)
        .then((record) => {
          // Re-check after the in-flight fetch resolves: a newer run may have
          // superseded this loop while the request was outstanding. Without
          // this, one more stale render/setTimeout would slip through before
          // the next tick's guard catches it.
          if (stopped) return;
          if (record) {
            renderRunStatus(record);
            renderProperties(record.artifacts.derivationReport, runKind);
            renderDerivationReport(record.artifacts.derivationReport, runKind);
            tryAutoLoadPane(runId, 'reference');
            tryAutoLoadPane(runId, 'roundtrip');
            if (isTerminal(record)) {
              stopped = true;
              window.__loadDiffPane(runId).catch(() => {
                // Best-effort diff load — the region-diff pipeline may not
                // have produced crops yet; the diff pane keeps its default
                // empty state on failure rather than leaking an unhandled
                // rejection.
              });
              return;
            }
          }
          setTimeout(tick, POLL_INTERVAL_MS);
        })
        .catch((err) => {
          // Same supersession re-check as the fulfilled path: a loop
          // superseded while its fetch was in flight must not write the
          // status line or reschedule when that fetch rejects.
          if (stopped) return;
          // A transient fetch/JSON/non-2xx error must not kill the poll loop
          // or leak an unhandled rejection — surface a diagnostic to the
          // status line (so a persistent failure is visible, not a silently
          // frozen UI) and keep polling until a terminal state is seen.
          document.getElementById('run-status').textContent =
            'poll error (retrying): ' + String((err && err.message) || err);
          setTimeout(tick, POLL_INTERVAL_MS);
        });
    }
    tick();
  }

  // ─── form wiring ────────────────────────────────────────────────────────

  function startRunOptions() {
    const formData = new FormData();
    const fileInput = document.getElementById('file-input');
    const file = fileInput.files && fileInput.files[0];
    formData.append('file', file);
    const section = document.getElementById('section-input').value.trim();
    const title = document.getElementById('title-input').value.trim();
    if (section) formData.append('section', section);
    if (title) formData.append('title', title);
    return formData;
  }

  function handleSubmit(event) {
    event.preventDefault();
    const fileInput = document.getElementById('file-input');
    if (!fileInput.files || !fileInput.files[0]) return;

    resetPaneState();
    fetch('/api/runs', { method: 'POST', body: startRunOptions() })
      .then((response) => response.json())
      .then((body) => {
        if (!body.success) throw new Error(body.error || 'failed to start run');
        pollRun(body.data.runId);
      })
      .catch((err) => {
        document.getElementById('run-status').textContent =
          'failed to start run: ' + String((err && err.message) || err);
      });
  }

  document.getElementById('run-form').addEventListener('submit', handleSubmit);

  // Exposed so scenario-picker.js (#305 task 7/7) can drive a header/footer
  // fixture run through the exact same poll loop / pane-loading / diff-
  // loading logic this form uses, rather than duplicating any of it — both
  // POST /api/runs and POST /api/header-footer-fixtures write into the same
  // RunStore, so one poller already covers both entry points. runKind
  // ('upload', the default, or 'scenario') only changes the empty-state
  // message shown while no derivation report exists yet (#506) — it is not
  // persisted anywhere.
  window.__pollRun = pollRun;
  window.__resetPaneState = resetPaneState;
})();
