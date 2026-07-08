// Scoring view (WS2, #424): the per-paragraph hierarchy-inference confidence
// report for one spec, worst-first, beside the spec it scores — same two-pane
// shape as the Report/audit view (js/audit.js), reusing its machinery:
// `expandAncestors` (tree.js) to reveal a row's paragraph inside a collapsed
// part/article, and `createHoverWalker` (popover.js) so hovering/arrow-keying a
// row steps the highlight without re-clicking each time.
//
// The filter/order logic (which rows a filter admits, and the document-order
// re-sort) lives in the pure scoring-filter.mjs so it can be unit-tested
// without a DOM (scoring.test.mjs) — this file is the DOM glue around it.

import { createHoverWalker } from './popover.js';
import { expandAncestors } from './tree.js';
import {
  SCORING_FILTERS,
  confidenceBand,
  selectScoringRows,
  buildPositionMap,
} from './scoring-filter.mjs';

const SIGNAL_LABELS = {
  1: 'numbering.xml',
  2: 'style chain',
  3: 'document order',
  4: 'text pattern',
  5: 'indentation',
};

const EMPTY_MESSAGE =
  'Load a spec into this project to review its per-paragraph hierarchy-inference confidence.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Section numbers and paragraph UUIDs never contain a double-quote, so a quoted
// attribute selector is safe; guard against a stray quote just in case (mirrors
// audit.js's attrSelector).
function attrSelector(attr, value) {
  return value.includes('"') ? null : `[${attr}="${value}"]`;
}

// Resolves the right-pane element a scored row should locate to, mirroring
// audit.js's openSheet 3-tier fallback (exact node -> sheet head -> nothing).
// The read-only render path (tree.js renderSpecSheet, no inline editing) only
// stamps [data-node-id] on body paragraph/note rows — part and article
// heading bars carry no anchor — so a scored heading row needs the same
// "you are here" degrade audit.js findings get, not a silent no-op. Takes a
// sheet-like object (anything exposing querySelector) so this stays testable
// without a real DOM.
export function resolveLocateTarget(sheet, nodeId) {
  if (!sheet) return { node: null, tier: 'none' };
  const selector = nodeId ? attrSelector('data-node-id', nodeId) : null;
  const node = selector ? sheet.querySelector(selector) : null;
  if (node) return { node, tier: 'exact' };
  const head = sheet.querySelector('.sheet-head');
  if (head) return { node: head, tier: 'head' };
  return { node: null, tier: 'none' };
}

// Monotonic stale-response guard for loadSelected: `next()` issues a token for
// a new in-flight request; `bump()` invalidates whatever is in flight WITHOUT
// issuing a new token — used when a refresh leaves no selection at all, so an
// older fetch can't repopulate a pane that now has nothing selected;
// `isCurrent()` reports whether a token is still the newest issued.
export function createRequestGuard() {
  let current = 0;
  return {
    next: () => (current += 1),
    bump: () => {
      current += 1;
    },
    isCurrent: (token) => token === current,
  };
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function signalLine(paragraph) {
  const used = SIGNAL_LABELS[paragraph.signalUsed] ?? `signal ${paragraph.signalUsed}`;
  const count = paragraph.agreed.length;
  const agreedText = count > 0 ? `${count} signal${count === 1 ? '' : 's'} agreed` : 'no signals agreed';
  return `S${paragraph.signalUsed} ${used} · ${agreedText}`;
}

export function initScoring(opts) {
  const {
    specSelect,
    filtersEl,
    summaryEl,
    rowsEl,
    specPane,
    specTitleEl,
    specHintEl,
    split,
    getSpecs,
    fetchHierarchyReport,
    renderSheet,
    displaySection,
    toast,
  } = opts;

  let selectedSpecId = null; // spec the picker currently targets
  // Sentinel so the very first refresh() always loads — even when the project
  // starts with zero specs (selectedSpecId stays null, which must still not
  // equal "nothing loaded yet"). Real loads always set this to null or an id.
  const NEVER_LOADED = Symbol('scoring-never-loaded');
  let loadedSpecId = NEVER_LOADED; // spec the report/pane were last loaded for
  const requestGuard = createRequestGuard(); // monotonic guard against a stale fetch clobbering a newer pick
  let currentReport = null;
  let currentPositions = new Map();
  let currentFilter = 'all';
  let selectedRow = null;
  let locatedNode = null;

  // ── Spec picker ───────────────────────────────────────────────────────────

  function specEntries() {
    return [...getSpecs().values()]
      .map((spec) => ({
        id: spec.tree.id,
        section: spec.tree.section,
        title: spec.tree.title || 'Untitled Section',
      }))
      .sort((a, b) => a.section.localeCompare(b.section));
  }

  function ensureSelection(entries) {
    if (entries.length === 0) {
      selectedSpecId = null;
      return;
    }
    if (!selectedSpecId || !entries.some((entry) => entry.id === selectedSpecId)) {
      selectedSpecId = entries[0].id;
    }
  }

  function renderPicker(entries) {
    specSelect.replaceChildren();
    for (const entry of entries) {
      const option = el('option', null, `${displaySection(entry.section)} — ${entry.title}`);
      option.value = entry.id;
      specSelect.appendChild(option);
    }
    specSelect.disabled = entries.length === 0;
    if (selectedSpecId) specSelect.value = selectedSpecId;
  }

  // ── Header + rows (left pane) ────────────────────────────────────────────

  function renderSummary(report) {
    summaryEl.replaceChildren();
    if (!report) return;
    const { scored, unscored, belowThreshold } = report.counts;
    summaryEl.appendChild(el('span', 'scoring-count', `${scored} scored`));
    summaryEl.appendChild(el('span', 'scoring-count', `${belowThreshold} below threshold`));
    if (unscored > 0) {
      summaryEl.appendChild(el('span', 'scoring-count is-unscored', `${unscored} unscored`));
    }
    if (report.unscoredReason) {
      summaryEl.appendChild(el('p', 'scoring-reason', report.unscoredReason));
    }
  }

  function renderFilters() {
    filtersEl.replaceChildren();
    for (const filter of SCORING_FILTERS) {
      const btn = el('button', 'compare-chip', filter.label);
      btn.type = 'button';
      btn.dataset.filter = filter.id;
      btn.classList.toggle('is-active', filter.id === currentFilter);
      btn.setAttribute('aria-pressed', String(filter.id === currentFilter));
      btn.addEventListener('click', () => {
        if (currentFilter === filter.id) return;
        currentFilter = filter.id;
        for (const chip of filtersEl.querySelectorAll('.compare-chip')) {
          const active = chip.dataset.filter === currentFilter;
          chip.classList.toggle('is-active', active);
          chip.setAttribute('aria-pressed', String(active));
        }
        renderRows();
      });
      filtersEl.appendChild(btn);
    }
  }

  function makeRow(paragraph) {
    const band = confidenceBand(paragraph.confidence);
    const row = el('li', `scoring-row is-${band}`);
    row.dataset.nodeId = paragraph.nodeId;
    row.tabIndex = 0;
    row.appendChild(
      el('span', `scoring-badge is-${band}`, `${Math.round(paragraph.confidence * 100)}%`)
    );
    row.appendChild(el('span', 'scoring-label', paragraph.label || '—'));
    row.appendChild(el('span', 'scoring-preview', paragraph.preview));
    row.appendChild(el('span', 'scoring-signal', signalLine(paragraph)));
    if (paragraph.conflicts && paragraph.conflicts.length > 0) {
      const count = paragraph.conflicts.length;
      row.appendChild(
        el('span', 'scoring-conflict', `${count} signal conflict${count === 1 ? '' : 's'}`)
      );
    }
    return row;
  }

  function renderRows() {
    rowsEl.replaceChildren();
    selectedRow = null;
    if (!currentReport) return;
    const rows = selectScoringRows(currentReport.paragraphs, currentFilter, currentPositions);
    if (rows.length === 0) {
      rowsEl.appendChild(el('p', 'scoring-empty', 'No paragraphs match this filter.'));
      return;
    }
    for (const paragraph of rows) rowsEl.appendChild(makeRow(paragraph));
  }

  // ── Right pane: spec render + paragraph locate ───────────────────────────

  function setPaneHead(title, hint) {
    if (specTitleEl) specTitleEl.textContent = title;
    if (specHintEl) specHintEl.textContent = hint;
  }

  function showEmptyPane(message, title = 'SPEC', hint = 'no spec selected') {
    loadedSpecId = null;
    locatedNode = null;
    specPane.replaceChildren(el('p', 'audit-empty', message));
    setPaneHead(title, hint);
  }

  function renderSpecPane(spec) {
    const sheet = renderSheet(spec);
    sheet.removeAttribute('id'); // never collide with the map board's sheet-<id>
    specPane.replaceChildren(sheet);
    loadedSpecId = spec.tree.id;
    locatedNode = null;
    setPaneHead(
      spec.tree.section ? displaySection(spec.tree.section) : 'Section',
      spec.tree.title || 'Untitled Section'
    );
  }

  function pulseNode(node) {
    const observer = new IntersectionObserver(
      (entries, obs) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        obs.disconnect();
        node.classList.remove('is-audit-pulse');
        void node.offsetWidth; // restart the animation
        node.classList.add('is-audit-pulse');
        node.addEventListener('animationend', () => node.classList.remove('is-audit-pulse'), {
          once: true,
        });
      },
      { root: specPane, threshold: 0 }
    );
    observer.observe(node);
    setTimeout(() => observer.disconnect(), 10000); // hygiene
  }

  function locateNode(node) {
    expandAncestors(node);
    if (locatedNode && locatedNode !== node) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
    }
    locatedNode = node;
    node.classList.add('is-audit-target');
    node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    pulseNode(node);
  }

  // Fallback target when a row has no [data-node-id] anchor of its own (part/
  // article heading rows — see resolveLocateTarget). Anchors to the sheet head
  // instead of the exact paragraph, mirroring audit.js's locateHead.
  function locateHead(head) {
    if (locatedNode && locatedNode !== head) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
    }
    locatedNode = head;
    head.classList.add('is-audit-target');
    head.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    pulseNode(head);
  }

  function selectRow(row) {
    if (selectedRow && selectedRow !== row) selectedRow.classList.remove('is-selected');
    selectedRow = row;
    row.classList.add('is-selected');
    row.scrollIntoView({ block: 'nearest' });
  }

  function locateRow(row) {
    selectRow(row);
    const sheet = specPane.querySelector('.spec-sheet');
    const { node, tier } = resolveLocateTarget(sheet, row.dataset.nodeId);
    if (tier === 'exact') {
      locateNode(node);
      return;
    }
    if (tier === 'head') {
      locateHead(node);
      return;
    }
    // No anchor at all — clear any stale highlight and scroll the pane to top
    // so the click still gives a "you are here" signal, never a silent no-op.
    if (locatedNode) {
      locatedNode.classList.remove('is-audit-target', 'is-audit-pulse');
      locatedNode = null;
    }
    specPane.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }

  // ── Load / refresh ───────────────────────────────────────────────────────

  async function loadSelected() {
    if (!selectedSpecId) {
      requestGuard.bump(); // invalidate any in-flight fetch — nothing is selected now
      currentReport = null;
      renderSummary(null);
      renderRows();
      showEmptyPane(EMPTY_MESSAGE);
      return;
    }
    const spec = getSpecs().get(selectedSpecId);
    if (!spec || !spec.tree) {
      requestGuard.bump(); // invalidate any in-flight fetch — this spec is gone
      showEmptyPane('This spec is no longer loaded in the project.');
      return;
    }
    const thisRequest = requestGuard.next();
    try {
      const report = await fetchHierarchyReport(selectedSpecId);
      if (!requestGuard.isCurrent(thisRequest)) return; // superseded by a newer pick
      currentReport = report;
      currentPositions = buildPositionMap(spec.tree);
      renderSummary(report);
      renderRows();
      renderSpecPane(spec);
    } catch (err) {
      if (!requestGuard.isCurrent(thisRequest)) return;
      // A failed load must leave the WHOLE view consistent with the failed
      // selection, not just the right pane — otherwise the left list/summary
      // keep showing the previously loaded spec's rows while the picker and
      // error message refer to the spec that just failed.
      currentReport = null;
      currentPositions = new Map();
      renderSummary(null);
      renderRows();
      toast?.(`Could not load the scoring report: ${err.message}`, 'err');
      showEmptyPane('Could not load the scoring report for this spec.');
    }
  }

  function fitHeight() {
    if (!split || split.offsetParent === null) return;
    const top = split.getBoundingClientRect().top;
    split.style.setProperty(
      '--audit-h',
      `${Math.max(320, Math.round(window.innerHeight - top))}px`
    );
  }

  // Repopulate the spec picker from the live project workspace and (re)load
  // only when the selection actually changed — an every-open refetch would
  // wipe the current row selection and re-scroll the pane for no reason.
  function refresh() {
    const entries = specEntries();
    ensureSelection(entries);
    renderPicker(entries);
    fitHeight();
    if (selectedSpecId !== loadedSpecId) void loadSelected();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  specSelect.addEventListener('change', () => {
    selectedSpecId = specSelect.value || null;
    void loadSelected();
  });

  rowsEl.addEventListener('click', (event) => {
    const row = event.target.closest?.('.scoring-row');
    if (row && rowsEl.contains(row)) locateRow(row);
  });

  createHoverWalker({
    itemSelector: '.scoring-row',
    listFor: (anchor) => [...(anchor.closest('.scoring-rows')?.querySelectorAll('.scoring-row') ?? [])],
    onStep: (row) => locateRow(row),
    prevTitle: 'Previous paragraph',
    nextTitle: 'Next paragraph',
    popClass: 'scoring-pop',
    keyboard: true,
    hideOnItemClick: false,
  });

  window.addEventListener('resize', fitHeight);

  renderFilters();
  showEmptyPane(EMPTY_MESSAGE);

  return { refresh, fit: fitHeight };
}
