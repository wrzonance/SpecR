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

  function fetchPaneBlob(runId, pane) {
    const url = `/api/runs/${encodeURIComponent(runId)}/files/${PANE_FILENAMES[pane]}`;
    return fetch(url).then((response) => {
      if (response.ok) return response.blob();
      const err = new Error(`pane file not ready (HTTP ${String(response.status)})`);
      err.notReady = response.status === 404;
      throw err;
    });
  }

  window.__loadPane = function loadPane(runId, pane) {
    const container = document.getElementById(PANE_CONTENT_IDS[pane]);
    paneState[pane] = { status: 'loading', error: null };
    return fetchPaneBlob(runId, pane)
      .then((blob) => docx.renderAsync(blob, container, null, RENDER_OPTIONS))
      .then(() => {
        paneState[pane] = { status: 'done', error: null };
      })
      .catch((err) => {
        paneState[pane] = { status: 'error', error: String((err && err.message) || err) };
        throw err;
      });
  };

  function tryAutoLoadPane(runId, pane) {
    if (paneState[pane].status !== 'idle') return;
    window.__loadPane(runId, pane).catch((err) => {
      // A 404 just means the pipeline hasn't produced this file yet — reset
      // to 'idle' so the next poll tick retries. Any other failure is a real
      // render error and stays surfaced via paneState[pane].error.
      if (err && err.notReady) paneState[pane] = { status: 'idle', error: null };
    });
  }

  function resetPaneState() {
    paneState.reference = { status: 'idle', error: null };
    paneState.roundtrip = { status: 'idle', error: null };
    clearChildren(document.getElementById(PANE_CONTENT_IDS.reference));
    clearChildren(document.getElementById(PANE_CONTENT_IDS.roundtrip));
  }

  // ─── geometry (window.__measure / window.__regionGeom) ────────────────
  // Field names (x/y/width/height, pageGeom/headerGeom/footerGeom) match
  // render/regions.ts's Geom and diff/pixel-diff.ts's RegionDiffInput
  // exactly, so a driving agent can feed this output straight into that
  // pipeline without reshaping it.

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

  function renderProperties(report) {
    const body = document.getElementById('properties-body');
    clearChildren(body);
    if (!report) {
      body.appendChild(el('p', { className: 'pane-empty', text: 'No derivation report yet.' }));
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

  function renderDerivationReport(report) {
    const body = document.getElementById('derivation-body');
    clearChildren(body);
    if (!report) {
      body.appendChild(el('p', { className: 'pane-empty', text: 'No derivation report yet.' }));
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
  const TERMINAL_STAGE = 'generate';

  function isTerminal(record) {
    return record.status === 'failed' || (record.stage === TERMINAL_STAGE && record.status === 'complete');
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

  function pollRun(runId) {
    let stopped = false;
    function tick() {
      if (stopped) return;
      pollOnce(runId)
        .then((record) => {
          if (record) {
            renderRunStatus(record);
            renderProperties(record.artifacts.derivationReport);
            renderDerivationReport(record.artifacts.derivationReport);
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
})();
