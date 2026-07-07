// Compare view — deterministic side-by-side matrix + inline review (#385, #395).
//
// Picks exactly two live specs, POSTs POST /reports/compare, and caches the
// grounded ComparisonReport client-side. From that one full matrix it renders
// two lenses that share filter + collapse state:
//   • Side-by-side — the aligned table (one column per source, word-diff cells).
//   • Inline review — a track-changes single-pager: differing rows merge into one
//     del/ins/shared flow, one-sided rows are wholly struck/inserted.
// Filter chips (All / Changes only / Only in A / Only in B) narrow both lenses;
// in "Changes only" each run of identical rows collapses into a divider that
// expands in place. Every present paragraph clicks through to the exact paragraph
// in the Report/audit pane (same anchor channel as the Compose Sources chips).
//
// Facts are computed by the endpoint; this view only renders and routes them.

import { postCompareReport } from './api.js';
import { buildCompareView, detectCompareFeatures } from './compare-model.mjs';
import { diffWords } from './word-diff.mjs';
import { COMPARE_FILTERS, resolveCounts, buildSegments } from './compare-filter.mjs';
import { buildInlineTokens } from './compare-inline.mjs';

const LEGEND = [
  ['is-identical', 'identical'],
  ['is-differing', 'differing'],
  ['is-only-a', 'only in one'],
];

const VIEW_MODES = [
  { id: 'side-by-side', label: 'Side-by-side' },
  { id: 'inline', label: 'Inline review' },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function plainTokens(text) {
  return text ? [{ text, changed: false }] : [];
}

export function initCompare(opts = {}) {
  const getCatalog = typeof opts.getCatalog === 'function' ? opts.getCatalog : () => [];
  const displaySection = typeof opts.displaySection === 'function' ? opts.displaySection : (s) => s;
  const onCite = typeof opts.onCite === 'function' ? opts.onCite : null;
  const onHandoff = typeof opts.onHandoff === 'function' ? opts.onHandoff : null;

  const selA = document.getElementById('compare-source-a');
  const selB = document.getElementById('compare-source-b');
  const baselineToggle = document.getElementById('compare-baseline');
  const runBtn = document.getElementById('compare-run');
  const handoffBtn = document.getElementById('compare-handoff');
  const statusEl = document.getElementById('compare-status');
  const legendEl = document.getElementById('compare-legend');
  const matrixEl = document.getElementById('compare-matrix');
  const toolbarEl = document.getElementById('compare-toolbar');
  const modesEl = document.getElementById('compare-modes');
  const filtersEl = document.getElementById('compare-filters');
  if (!selA || !selB || !runBtn || !matrixEl) return { refresh() {} };

  let busy = false;
  let lastSources = null; // [{specId, section, title, origin}] for the handoff
  let view = null; // buildCompareView result — the full matrix, cached for re-render
  let lastReport = null; // raw report, for the server summary counts
  let viewMode = 'side-by-side';
  let activeFilter = 'all';
  const expandedGaps = new Set(); // matrix keys of context gaps the user opened

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  function specById(specId) {
    return getCatalog().find((spec) => spec.specId === specId) ?? null;
  }

  function catalogOption(spec) {
    const option = document.createElement('option');
    option.value = spec.specId;
    option.textContent = `${displaySection(spec.section)} — ${spec.title || 'Untitled'} · ${spec.origin}`;
    return option;
  }

  function refresh() {
    const catalog = getCatalog();
    const prevA = selA.value;
    const prevB = selB.value;
    for (const select of [selA, selB]) {
      select.replaceChildren();
      for (const spec of catalog) select.appendChild(catalogOption(spec));
    }
    if (catalog.some((s) => s.specId === prevA)) selA.value = prevA;
    if (catalog.some((s) => s.specId === prevB)) selB.value = prevB;
    else if (catalog.length > 1 && selB.value === selA.value) selB.selectedIndex = 1;
    runBtn.disabled = catalog.length < 2;
    if (catalog.length < 2) {
      setStatus('Load two specs (the same section in two projects, or a project + its master) to compare.');
    } else if (!busy) {
      setStatus('');
    }
  }

  function renderLegend() {
    if (!legendEl) return;
    legendEl.replaceChildren();
    for (const [cls, label] of LEGEND) {
      const item = el('span', 'compare-legend-item');
      const swatch = el('span', `compare-legend-swatch compare-row ${cls}`);
      item.append(swatch, document.createTextNode(label));
      legendEl.appendChild(item);
    }
    legendEl.hidden = false;
  }

  // --- Toolbar: view-mode segmented control + filter chips ------------------

  function renderModes() {
    if (!modesEl) return;
    modesEl.replaceChildren();
    for (const mode of VIEW_MODES) {
      const active = mode.id === viewMode;
      const btn = el('button', 'compare-mode-btn', mode.label);
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(active));
      btn.classList.toggle('is-active', active);
      btn.addEventListener('click', () => setMode(mode.id));
      modesEl.appendChild(btn);
    }
  }

  function renderFilters(counts) {
    if (!filtersEl) return;
    filtersEl.replaceChildren();
    for (const filter of COMPARE_FILTERS) {
      const active = filter.id === activeFilter;
      const count = counts[filter.id] ?? 0;
      const btn = el('button', 'compare-chip');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(active));
      btn.setAttribute('aria-label', `${filter.label}, ${count} paragraphs`);
      btn.classList.toggle('is-active', active);
      btn.append(document.createTextNode(filter.label), el('span', 'compare-chip-count', String(count)));
      btn.addEventListener('click', () => setFilter(filter.id));
      filtersEl.appendChild(btn);
    }
  }

  function setMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    expandedGaps.clear();
    render();
  }

  function setFilter(filter) {
    if (filter === activeFilter) return;
    activeFilter = filter;
    expandedGaps.clear();
    render();
  }

  // --- Side-by-side table ---------------------------------------------------

  function headRow(columns) {
    const tr = document.createElement('tr');
    tr.appendChild(el('th', 'compare-col-head compare-state', 'ALIGNED ¶'));
    for (const col of columns) {
      const th = el('th', 'compare-col-head');
      th.appendChild(el('span', 'compare-col-section', displaySection(col.section)));
      th.appendChild(el('span', 'compare-col-title', col.title || 'Untitled section'));
      tr.appendChild(th);
    }
    return tr;
  }

  // A present cell renders word-diff-highlighted text against its row-mate and
  // clicks through to the exact paragraph; an absent cell is inert.
  function renderCell(cell, tokens, column) {
    if (cell?.present !== true) {
      return el('td', 'compare-cell is-absent', '— not present —');
    }
    const td = el('td', 'compare-cell');
    // The click-through citation is a core feature — make it keyboard-operable
    // too (focusable button semantics + Enter/Space), not mouse-only.
    td.tabIndex = 0;
    td.setAttribute('role', 'button');
    for (const token of tokens) {
      if (token.changed && token.text.trim() !== '') {
        td.appendChild(el('span', 'compare-diff', token.text));
      } else {
        td.appendChild(document.createTextNode(token.text));
      }
    }
    const cite = () =>
      onCite?.({ section: column.section, specId: cell.specId, paragraphId: cell.paragraphUuid });
    td.addEventListener('click', cite);
    td.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        cite();
      }
    });
    return td;
  }

  function renderRow(row, columns) {
    const tr = el('tr', `compare-row is-${row.state}`);
    tr.appendChild(el('td', 'compare-state', row.state.replace('-', ' ')));
    const textA = row.cells[0]?.present ? row.cells[0].text : '';
    const textB = row.cells[1]?.present ? row.cells[1].text : '';
    // Only differing rows earn a word diff; identical / one-sided rows render plain.
    const highlighted = row.state === 'differing';
    const { a, b } = highlighted ? diffWords(textA, textB) : { a: null, b: null };
    tr.appendChild(renderCell(row.cells[0], a ?? plainTokens(textA), columns[0]));
    tr.appendChild(renderCell(row.cells[1], b ?? plainTokens(textB), columns[1]));
    return tr;
  }

  function gapTableRow(segment) {
    const tr = el('tr', 'compare-gap-row');
    const td = document.createElement('td');
    td.colSpan = view.columns.length + 1; // + the ALIGNED ¶ state column
    td.appendChild(gapDivider(segment));
    tr.appendChild(td);
    return tr;
  }

  // Append an expanded gap's revealed rows, tagging the first so keyboard focus can
  // land on it once the divider that revealed them is gone (see restoreFocus).
  function appendRevealed(container, segment, buildNode) {
    segment.rows.forEach((row, index) => {
      const node = buildNode(row);
      if (index === 0) node.dataset.revealedFrom = String(segment.key);
      container.appendChild(node);
    });
  }

  function renderTable(segments) {
    const table = el('table', 'compare-table');
    const thead = document.createElement('thead');
    thead.appendChild(headRow(view.columns));
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const segment of segments) {
      if (segment.kind === 'row') tbody.appendChild(renderRow(segment.row, view.columns));
      else if (expandedGaps.has(segment.key))
        appendRevealed(tbody, segment, (row) => renderRow(row, view.columns));
      else tbody.appendChild(gapTableRow(segment));
    }
    table.appendChild(tbody);
    return table;
  }

  // --- Inline review (track-changes single-pager) --------------------------

  function inlineToken(token) {
    if (token.kind === 'del') return el('del', 'compare-del', token.text);
    if (token.kind === 'ins') return el('ins', 'compare-ins', token.text);
    return document.createTextNode(token.text);
  }

  // A small A/B chip per present side routes into the Report pane — same anchor
  // channel as the table cells, keyboard-operable as a native button.
  function citeChip(label, cell, column) {
    const btn = el('button', 'compare-inline-chip', label);
    btn.type = 'button';
    btn.setAttribute('aria-label', `Open source ${label} paragraph in the Report pane`);
    btn.addEventListener('click', () =>
      onCite?.({ section: column.section, specId: cell.specId, paragraphId: cell.paragraphUuid })
    );
    return btn;
  }

  function inlinePara(row) {
    const para = el('div', `compare-inline-para is-${row.state}`);
    const gutter = el('span', 'compare-inline-gutter');
    const [colA, colB] = view.columns;
    if (row.cells?.[0]?.present && colA) gutter.appendChild(citeChip('A', row.cells[0], colA));
    if (row.cells?.[1]?.present && colB) gutter.appendChild(citeChip('B', row.cells[1], colB));
    para.appendChild(gutter);
    const text = el('span', 'compare-inline-text');
    for (const token of buildInlineTokens(row)) text.appendChild(inlineToken(token));
    para.appendChild(text);
    return para;
  }

  function renderInline(segments) {
    const flow = el('div', 'compare-inline');
    for (const segment of segments) {
      if (segment.kind === 'row') flow.appendChild(inlinePara(segment.row));
      else if (expandedGaps.has(segment.key)) appendRevealed(flow, segment, inlinePara);
      else flow.appendChild(gapDivider(segment));
    }
    return flow;
  }

  // --- Shared context expander ---------------------------------------------

  function gapDivider(segment) {
    const count = segment.rows.length;
    const label = `· ${count} unchanged paragraph${count === 1 ? '' : 's'} — click to expand ·`;
    const btn = el('button', 'compare-gap', label);
    btn.type = 'button';
    btn.dataset.gapKey = String(segment.key);
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => {
      expandedGaps.add(segment.key);
      render();
    });
    return btn;
  }

  // --- Render dispatch + status --------------------------------------------

  function reportStatus() {
    const features = detectCompareFeatures(lastReport);
    const differing = view.rows.filter((r) => r.state === 'differing').length;
    const oneSided = view.rows.filter((r) => r.state === 'only-a' || r.state === 'only-b').length;
    const base = `${view.rows.length} aligned ¶ · ${differing} differing · ${oneSided} only-in-one`;
    const baseline = view.hasBaseline ? ' · baseline lens on' : '';
    setStatus(features.summary ? `${base}${baseline} · server summary attached` : `${base}${baseline}`);
  }

  // render() runs from a clicked control's OWN handler (mode tab, filter chip, gap
  // divider), and it tears down + rebuilds modes/filters/matrix via replaceChildren,
  // detaching that button mid-click so focus falls to <body>. Snapshot what held
  // focus before teardown; restoreFocus lands it on the logical successor after.
  function focusAnchor() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (modesEl?.contains(active)) return { kind: 'mode' };
    if (filtersEl?.contains(active)) return { kind: 'filter' };
    if (active.classList.contains('compare-gap'))
      return { kind: 'gap', key: active.dataset.gapKey };
    return null;
  }

  function restoreFocus(anchor) {
    if (anchor?.kind === 'mode') return void modesEl?.querySelector('.is-active')?.focus();
    if (anchor?.kind === 'filter') return void filtersEl?.querySelector('.is-active')?.focus();
    if (anchor?.kind !== 'gap' || anchor.key == null) return;
    // The expanded divider is gone — land on the first paragraph it revealed,
    // made programmatically focusable for this one move (standard disclosure).
    const revealed = matrixEl.querySelector(`[data-revealed-from="${anchor.key}"]`);
    if (revealed) {
      revealed.tabIndex = -1;
      revealed.focus();
    }
  }

  function render() {
    if (!view) return;
    const anchor = focusAnchor();
    const counts = resolveCounts(view.rows, lastReport?.summary ?? null);
    renderModes();
    renderFilters(counts);
    matrixEl.replaceChildren();
    if (view.columns.length < 2 || view.rows.length === 0) {
      matrixEl.appendChild(el('p', 'compare-empty', 'No aligned paragraphs to compare.'));
      setStatus('No aligned paragraphs to compare.');
      if (legendEl) legendEl.hidden = true;
      return;
    }
    const segments = buildSegments(view.rows, activeFilter);
    if (segments.length === 0) {
      matrixEl.appendChild(el('p', 'compare-empty', 'No paragraphs match this filter.'));
    } else {
      matrixEl.appendChild(viewMode === 'inline' ? renderInline(segments) : renderTable(segments));
    }
    renderLegend();
    reportStatus();
    restoreFocus(anchor);
  }

  async function run() {
    if (busy) return;
    const a = selA.value;
    const b = selB.value;
    if (!a || !b || a === b) {
      setStatus('Pick two different specs to compare.', true);
      return;
    }
    busy = true;
    runBtn.disabled = true;
    runBtn.textContent = 'Comparing…';
    if (handoffBtn) handoffBtn.hidden = true;
    if (toolbarEl) toolbarEl.hidden = true;
    matrixEl.replaceChildren();
    setStatus('Running grounded comparison…');
    try {
      const options = baselineToggle?.checked ? { baseline: a } : {};
      const report = await postCompareReport([a, b], options);
      lastReport = report;
      view = buildCompareView(report);
      expandedGaps.clear();
      if (toolbarEl) toolbarEl.hidden = !(view.columns.length >= 2 && view.rows.length > 0);
      render();
      lastSources = [specById(a), specById(b)].filter(Boolean);
      if (handoffBtn) handoffBtn.hidden = lastSources.length !== 2;
    } catch (err) {
      setStatus(`comparison failed: ${err.message}`, true);
    } finally {
      busy = false;
      runBtn.disabled = false;
      runBtn.textContent = 'Run comparison';
    }
  }

  function handoff() {
    if (!onHandoff || !lastSources || lastSources.length !== 2) return;
    onHandoff({
      sources: lastSources.map((s) => s.specId),
      sections: lastSources.map((s) => s.section),
      labels: lastSources.map((s) => `${displaySection(s.section)} (${s.origin})`),
    });
  }

  runBtn.addEventListener('click', () => void run());
  handoffBtn?.addEventListener('click', handoff);
  refresh();
  return { refresh };
}
