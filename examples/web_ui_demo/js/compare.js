// Compare view — deterministic side-by-side matrix (#385).
//
// Picks exactly two live specs, POSTs POST /reports/compare, and renders the
// grounded ComparisonReport as an aligned matrix: one column per source, one
// row per resolved-origin paragraph. Differing cells are word-diff highlighted;
// every present cell clicks through to the exact paragraph in the Report/audit
// pane (same anchor channel as the Compose Sources chips). A one-click handoff
// pre-fills the Compose agent to narrate the differences.
//
// Facts are computed by the endpoint; this view only renders and routes them.

import { postCompareReport } from './api.js';
import { buildCompareView, detectCompareFeatures } from './compare-model.mjs';
import { diffWords } from './word-diff.mjs';

const LEGEND = [
  ['is-identical', 'identical'],
  ['is-differing', 'differing'],
  ['is-only-a', 'only in one'],
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
  if (!selA || !selB || !runBtn || !matrixEl) return { refresh() {} };

  let busy = false;
  let lastSources = null; // [{specId, section, title, origin}] for the handoff

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

  function reportSummary(view, report) {
    const features = detectCompareFeatures(report);
    const differing = view.rows.filter((r) => r.state === 'differing').length;
    const oneSided = view.rows.filter((r) => r.state === 'only-a' || r.state === 'only-b').length;
    const base = `${view.rows.length} aligned ¶ · ${differing} differing · ${oneSided} only-in-one`;
    const baseline = view.hasBaseline ? ' · baseline lens on' : '';
    setStatus(features.summary ? `${base}${baseline} · server summary attached` : `${base}${baseline}`);
  }

  function renderMatrix(report) {
    const view = buildCompareView(report);
    matrixEl.replaceChildren();
    if (view.columns.length < 2 || view.rows.length === 0) {
      matrixEl.appendChild(el('p', 'compare-empty', 'No aligned paragraphs to compare.'));
      setStatus('No aligned paragraphs to compare.');
      return;
    }
    const table = el('table', 'compare-table');
    const thead = document.createElement('thead');
    thead.appendChild(headRow(view.columns));
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const row of view.rows) tbody.appendChild(renderRow(row, view.columns));
    table.appendChild(tbody);
    matrixEl.appendChild(table);
    renderLegend();
    reportSummary(view, report);
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
    matrixEl.replaceChildren();
    setStatus('Running grounded comparison…');
    try {
      const options = baselineToggle?.checked ? { baseline: a } : {};
      const report = await postCompareReport([a, b], options);
      renderMatrix(report);
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
