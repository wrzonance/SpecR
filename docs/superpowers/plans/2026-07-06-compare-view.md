# Compare View (web_ui_demo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic "Compare" view to `examples/web_ui_demo/` that picks two live specs, renders the grounded `POST /reports/compare` matrix side-by-side with word-level diff highlighting and click-through grounding, and hands the comparison to the Compose agent in one click.

**Architecture:** Plain ES modules, no build step, no new dependencies. Two new pure helpers (`js/word-diff.mjs`, `js/compare-model.mjs`) carry all testable logic (LCS word diff, matrix→view-model mapping, feature detection). A thin view controller (`js/compare.js`) wires the DOM following the existing tab pattern (`initCompose` / `initAudit`). Cells click through to the existing Report/audit pane via the same `audit.showAnchor` anchor channel the Compose Sources chips use. Compose gains a `prefill(text)` method + one example chip for the handoff. `server.mjs` gains `/reports` to its proxy prefixes.

**Tech Stack:** ES modules, `node --test` (demo test runner, outside CI vitest), existing `js/api.js` REST client, `POST /reports/compare` (ADR-047), CSS tokens in `css/app.css`.

## Global Constraints

- ALL changes inside `examples/web_ui_demo/` (plus its README). NO `src/` changes, NO `openapi.yaml` changes.
- No build step, no framework, no new dependencies. Match existing code style: small files, existing CSS token/theme patterns.
- Demo tests run via `node --test examples/web_ui_demo/*.test.mjs`. New PURE helpers get `.test.mjs` coverage beside the code. Keep all demo tests green.
- Functions ≤50 lines, files small, split modules.
- Consume `POST /reports/compare` read-only. Today's contract: request `{ sources: [uuid, uuid], baseline?: uuid }`; response `ComparisonReport { columns:[{specId,section,title}], rows:[{originId,cells:[Cell,Cell]}], baseline?, drift? }` where `Cell = {present:true,specId,paragraphUuid,text} | {present:false}`.
- Companion #384 additively adds response `summary` / `alignedBy` and request `alignment` / `include`. Feature-DETECT: response fields by presence; request options gated behind a `features.js` flag defaulting OFF so today's strict contract is never violated.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit scope: `feat(example): …`. Branch: `feat/issue-385`.

---

### Task 1: Word-level diff pure helper

**Files:**
- Create: `examples/web_ui_demo/js/word-diff.mjs`
- Test: `examples/web_ui_demo/word-diff.test.mjs`

**Interfaces:**
- Produces: `diffWords(a: string, b: string) => { a: Token[], b: Token[] }` where `Token = { text: string, changed: boolean }`. Tokens preserve original spacing so `.map(t => t.text).join('')` round-trips each input. `changed` marks tokens absent from the LCS of whitespace-split words.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffWords } from './js/word-diff.mjs';

test('diffWords marks nothing changed for identical strings', () => {
  const { a, b } = diffWords('the quick brown fox', 'the quick brown fox');
  assert.ok(a.every((t) => !t.changed));
  assert.ok(b.every((t) => !t.changed));
});

test('diffWords round-trips the original text', () => {
  const inputA = 'Concrete shall be 4000 psi.';
  const inputB = 'Concrete shall be 3000 psi minimum.';
  const { a, b } = diffWords(inputA, inputB);
  assert.equal(a.map((t) => t.text).join(''), inputA);
  assert.equal(b.map((t) => t.text).join(''), inputB);
});

test('diffWords flags only the differing words', () => {
  const { a, b } = diffWords('4000 psi concrete', '3000 psi concrete');
  const changedA = a.filter((t) => t.changed).map((t) => t.text.trim());
  const changedB = b.filter((t) => t.changed).map((t) => t.text.trim());
  assert.deepEqual(changedA, ['4000']);
  assert.deepEqual(changedB, ['3000']);
});

test('diffWords treats empty input as all-changed against non-empty', () => {
  const { a, b } = diffWords('', 'new text');
  assert.equal(a.length, 0);
  assert.ok(b.some((t) => t.changed && t.text.trim() !== ''));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/word-diff.test.mjs`
Expected: FAIL — cannot find module `./js/word-diff.mjs`.

- [ ] **Step 3: Write minimal implementation**

Tokenize into alternating word / whitespace tokens (regex `/(\s+)/`), compute an LCS over the word tokens only, mark word tokens not in the LCS as `changed`, whitespace always `changed:false`.

```javascript
// Word-level diff for the Compare view (#385). Pure, no dependencies.
// Splits each string into word + whitespace tokens, computes the longest
// common subsequence over the WORDS, and marks any word not on the LCS path
// as `changed`. Whitespace tokens are never flagged, so joining a side's
// token .text round-trips its original input exactly.

function tokenize(text) {
  // Keep the separators: odd indices are the whitespace runs.
  return text.split(/(\s+)/).filter((piece) => piece.length > 0);
}

function isWord(token) {
  return !/^\s+$/.test(token);
}

// LCS length table over two word arrays.
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// Walk the table to a Set of matched indices on each side.
function matchedIndices(a, b) {
  const table = lcsTable(a, b);
  const inA = new Set();
  const inB = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA.add(i);
      inB.add(j);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { inA, inB };
}

// Map raw token strings to {text, changed}, using the matched WORD positions.
function mark(tokens, matched) {
  let wordIndex = -1;
  return tokens.map((text) => {
    if (!isWord(text)) return { text, changed: false };
    wordIndex += 1;
    return { text, changed: !matched.has(wordIndex) };
  });
}

export function diffWords(a, b) {
  const tokensA = tokenize(a ?? '');
  const tokensB = tokenize(b ?? '');
  const wordsA = tokensA.filter(isWord);
  const wordsB = tokensB.filter(isWord);
  const { inA, inB } = matchedIndices(wordsA, wordsB);
  return { a: mark(tokensA, inA), b: mark(tokensB, inB) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/word-diff.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/js/word-diff.mjs examples/web_ui_demo/word-diff.test.mjs
git commit -m "feat(example): word-level diff helper for Compare view"
```

---

### Task 2: Compare view-model + feature-detection pure helper

**Files:**
- Create: `examples/web_ui_demo/js/compare-model.mjs`
- Test: `examples/web_ui_demo/compare-model.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 (the view composes both; the model stays diff-agnostic).
- Produces:
  - `cellState(cellA, cellB) => 'identical' | 'differing' | 'only-a' | 'only-b' | 'absent'`.
  - `buildCompareView(report) => { columns: Column[], rows: ViewRow[], hasBaseline: boolean, drift: DriftEntry[] }` where `ViewRow = { originId, cells: [Cell, Cell], state, baselineStates: (string[]|null) }` and `state` is the `cellState` of the two cells.
  - `detectCompareFeatures(report) => { summary: boolean, alignedBy: boolean }` — presence-based detection of #384 additive response fields.
  - `baselineStatesFor(report, originId) => string[] | null` — the per-column baseline lens states for a row, or null when no baseline lens.

- [ ] **Step 1: Write the failing test**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellState,
  buildCompareView,
  detectCompareFeatures,
  baselineStatesFor,
} from './js/compare-model.mjs';

const present = (specId, text) => ({ present: true, specId, paragraphUuid: `${specId}-p`, text });
const absent = () => ({ present: false });

test('cellState classifies identical, differing, and one-sided cells', () => {
  assert.equal(cellState(present('a', 'x'), present('b', 'x')), 'identical');
  assert.equal(cellState(present('a', 'x'), present('b', 'y')), 'differing');
  assert.equal(cellState(present('a', 'x'), absent()), 'only-a');
  assert.equal(cellState(absent(), present('b', 'y')), 'only-b');
  assert.equal(cellState(absent(), absent()), 'absent');
});

test('cellState ignores whitespace-only differences', () => {
  assert.equal(cellState(present('a', 'x  y'), present('b', 'x y')), 'identical');
});

test('buildCompareView maps columns, rows, and per-row state', () => {
  const report = {
    columns: [
      { specId: 'a', section: '03 30 00', title: 'Cast-in-Place' },
      { specId: 'b', section: '03 30 00', title: 'Concrete' },
    ],
    rows: [
      { originId: 'o1', cells: [present('a', 'same'), present('b', 'same')] },
      { originId: 'o2', cells: [present('a', '4000 psi'), present('b', '3000 psi')] },
      { originId: 'o3', cells: [present('a', 'only a'), absent()] },
    ],
  };
  const view = buildCompareView(report);
  assert.equal(view.columns.length, 2);
  assert.deepEqual(
    view.rows.map((r) => r.state),
    ['identical', 'differing', 'only-a']
  );
  assert.equal(view.hasBaseline, false);
  assert.equal(view.rows[0].baselineStates, null);
});

test('buildCompareView surfaces the baseline lens states per row when present', () => {
  const report = {
    columns: [
      { specId: 'a', section: '03 30 00', title: 'A' },
      { specId: 'b', section: '03 30 00', title: 'B' },
    ],
    rows: [{ originId: 'o1', cells: [present('a', 'x'), present('b', 'y')] }],
    baseline: { specId: 'a', rows: [{ originId: 'o1', states: ['baseline', 'modified'] }] },
  };
  const view = buildCompareView(report);
  assert.equal(view.hasBaseline, true);
  assert.deepEqual(view.rows[0].baselineStates, ['baseline', 'modified']);
  assert.deepEqual(baselineStatesFor(report, 'o1'), ['baseline', 'modified']);
  assert.equal(baselineStatesFor(report, 'missing'), null);
});

test('detectCompareFeatures reads additive #384 fields by presence', () => {
  assert.deepEqual(detectCompareFeatures({ columns: [], rows: [] }), {
    summary: false,
    alignedBy: false,
  });
  assert.deepEqual(
    detectCompareFeatures({ columns: [], rows: [], summary: { differing: 2 }, alignedBy: 'origin' }),
    { summary: true, alignedBy: true }
  );
});

test('buildCompareView tolerates a missing/empty report', () => {
  const view = buildCompareView(null);
  assert.deepEqual(view.columns, []);
  assert.deepEqual(view.rows, []);
  assert.equal(view.hasBaseline, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test examples/web_ui_demo/compare-model.test.mjs`
Expected: FAIL — cannot find module `./js/compare-model.mjs`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// Compare view-model + feature detection for the Compare view (#385). Pure,
// no dependencies. Maps the grounded ComparisonReport (ADR-047) into a
// render-ready shape, classifies each aligned row's cell pair, and
// presence-detects the additive #384 response fields (summary, alignedBy).

// Collapse runs of whitespace so "x  y" and "x y" compare equal — the matrix
// aligns verbatim text, but a whitespace-only delta is not a real difference.
function normalize(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function cellState(cellA, cellB) {
  const a = cellA?.present === true;
  const b = cellB?.present === true;
  if (!a && !b) return 'absent';
  if (a && !b) return 'only-a';
  if (!a && b) return 'only-b';
  return normalize(cellA.text) === normalize(cellB.text) ? 'identical' : 'differing';
}

export function baselineStatesFor(report, originId) {
  const lensRows = report?.baseline?.rows;
  if (!Array.isArray(lensRows)) return null;
  const match = lensRows.find((row) => row.originId === originId);
  return Array.isArray(match?.states) ? match.states : null;
}

export function detectCompareFeatures(report) {
  return {
    summary: report?.summary != null,
    alignedBy: typeof report?.alignedBy === 'string' && report.alignedBy !== '',
  };
}

export function buildCompareView(report) {
  const columns = Array.isArray(report?.columns) ? report.columns : [];
  const rawRows = Array.isArray(report?.rows) ? report.rows : [];
  const hasBaseline = Array.isArray(report?.baseline?.rows);
  const rows = rawRows.map((row) => ({
    originId: row.originId,
    cells: row.cells ?? [],
    state: cellState(row.cells?.[0], row.cells?.[1]),
    baselineStates: baselineStatesFor(report, row.originId),
  }));
  return { columns, rows, hasBaseline, drift: report?.drift ?? [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test examples/web_ui_demo/compare-model.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/js/compare-model.mjs examples/web_ui_demo/compare-model.test.mjs
git commit -m "feat(example): Compare view-model + feature detection helper"
```

---

### Task 3: REST call, proxy prefix, and feature flag

**Files:**
- Modify: `examples/web_ui_demo/js/api.js` (add `postCompareReport`)
- Modify: `examples/web_ui_demo/server.mjs:60-71` (add `/reports` to `API_PREFIXES`)
- Modify: `examples/web_ui_demo/js/features.js` (add `compareAlignment: false`)

**Interfaces:**
- Produces: `postCompareReport(sources: string[], { baseline?: string } = {}) => Promise<ComparisonReport>` in `api.js`, using the existing `sendJson('POST', '/reports/compare', body)`.

- [ ] **Step 1: Add the API call** to `js/api.js` (after `getSubmittalRegister`):

```javascript
// Grounded cross-spec comparison (ADR-047). `sources` is exactly two live spec
// UUIDs; optional `baseline` must be one of them. Resolves with the
// ComparisonReport { columns, rows, baseline?, drift? }. 404 if a source id is
// not a live spec; 422 on a malformed request.
export function postCompareReport(sources, { baseline } = {}) {
  const body = { sources };
  if (baseline) body.baseline = baseline;
  return sendJson('POST', '/reports/compare', body);
}
```

- [ ] **Step 2: Add `/reports` to the proxy prefixes** in `server.mjs`:

```javascript
const API_PREFIXES = [
  '/health',
  '/specs',
  '/parse',
  '/projects',
  '/libraries',
  '/packages',
  '/revisions',
  '/templates',
  '/numbering-profiles',
  '/reports',
  '/mcp',
];
```

- [ ] **Step 3: Add the feature flag** to `js/features.js` (inside the `API_FEATURES` object):

```javascript
  compareAlignment: false, // POST /reports/compare alignment/include request options (#384 — flip when landed)
```

- [ ] **Step 4: Verify the demo still boots and tests stay green**

Run: `node --test examples/web_ui_demo/*.test.mjs`
Expected: PASS (existing suites + Tasks 1-2).

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/js/api.js examples/web_ui_demo/server.mjs examples/web_ui_demo/js/features.js
git commit -m "feat(example): wire /reports/compare REST call + proxy prefix"
```

---

### Task 4: Compare tab markup + styles

**Files:**
- Modify: `examples/web_ui_demo/index.html` (nav tab + `view-compare` panel)
- Modify: `examples/web_ui_demo/css/app.css` (append `.compare-*` styles)

**Interfaces:**
- Produces the DOM ids the Task 5 controller binds: `#compare-source-a`, `#compare-source-b`, `#compare-baseline`, `#compare-run`, `#compare-handoff`, `#compare-status`, `#compare-matrix`, `#compare-legend`.

- [ ] **Step 1: Add the nav tab** after the Compose tab (`index.html:65`):

```html
<button class="view-tab" type="button" data-view="compare">Compare</button>
```

- [ ] **Step 2: Add the view panel** after `view-compose` closes (`index.html:512`):

```html
    <section class="app-view" id="view-compare" data-view-panel="compare" hidden>
      <div class="compare">
        <div class="band-rule">
          <h2 class="band-title">COMPARE SPECS</h2>
          <p class="band-hint">deterministic · grounded matrix · aligned by resolved origin</p>
        </div>
        <p class="compare-lede">
          Pick two live specs — the same section held by two projects, or a project against its
          master — and see a grounded, paragraph-aligned matrix. Differing paragraphs are
          highlighted word by word; every present cell clicks through to the exact paragraph in the
          Report pane. Hand the whole comparison to the agent to narrate it.
        </p>
        <div class="compare-pickers">
          <label class="compare-field">
            <span>SOURCE A</span>
            <select id="compare-source-a"></select>
          </label>
          <label class="compare-field">
            <span>SOURCE B</span>
            <select id="compare-source-b"></select>
          </label>
          <label class="compare-baseline-toggle">
            <input type="checkbox" id="compare-baseline" />
            <span>Use Source A as baseline (added / removed / modified lens)</span>
          </label>
        </div>
        <div class="compare-actions">
          <button class="toc-btn is-primary" id="compare-run" type="button">Run comparison</button>
          <button class="toc-btn" id="compare-handoff" type="button" hidden>
            Ask SpecR to summarize
          </button>
        </div>
        <div class="compare-status" id="compare-status" aria-live="polite"></div>
        <div class="compare-legend" id="compare-legend" hidden></div>
        <div class="compare-matrix" id="compare-matrix"></div>
      </div>
    </section>
```

- [ ] **Step 3: Append the styles** to `css/app.css` (reuse tokens `--sheet`, `--sheet-dim`, `--line`, `--line-dim`, `--muted`, `--amber`, `--ok`, `--err`, `--mono`, `--serif`):

```css
/* ── Compare view (#385) ─────────────────────────────────────────────────── */
.compare {
  position: relative;
  z-index: 1;
  padding: 0.9rem 2rem 8rem;
  display: grid;
  gap: 0.85rem;
}
.compare-lede {
  margin: 0;
  max-width: 74ch;
  font-family: var(--serif);
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--ink-on-vellum);
}
.compare-pickers {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  align-items: end;
}
.compare-field {
  display: grid;
  gap: 0.3rem;
  font: 0.62rem var(--mono);
  letter-spacing: 0.14em;
  color: var(--muted);
  min-width: 22ch;
  flex: 1 1 26ch;
}
.compare-field select {
  font: 0.8rem var(--mono);
  padding: 0.45rem 0.5rem;
  border: 1px solid var(--line-dim);
  background: var(--sheet);
  color: var(--vellum);
}
.compare-baseline-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font: 0.7rem var(--mono);
  color: var(--muted);
}
.compare-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.compare-status {
  font: 0.66rem var(--mono);
  letter-spacing: 0.05em;
  color: var(--muted);
  min-height: 1rem;
}
.compare-status.is-error {
  color: var(--err);
}
.compare-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.9rem;
  font: 0.62rem var(--mono);
  letter-spacing: 0.06em;
  color: var(--muted);
}
.compare-legend-swatch {
  display: inline-block;
  width: 0.75rem;
  height: 0.75rem;
  margin-right: 0.3rem;
  vertical-align: -1px;
  border: 1px solid var(--line-dim);
}
.compare-matrix {
  overflow-x: auto;
}
.compare-table {
  border-collapse: collapse;
  width: 100%;
  font-family: var(--serif);
}
.compare-table th,
.compare-table td {
  border: 1px solid var(--line-dim);
  padding: 0.5rem 0.6rem;
  vertical-align: top;
  text-align: left;
}
.compare-col-head {
  background: var(--sheet-dim);
  position: sticky;
  top: 0;
}
.compare-col-section {
  font: 0.72rem var(--mono);
  letter-spacing: 0.06em;
  color: var(--line);
}
.compare-col-title {
  display: block;
  font-size: 0.78rem;
  color: var(--muted);
}
.compare-cell {
  font-size: 0.82rem;
  line-height: 1.45;
  cursor: pointer;
  background: var(--sheet);
}
.compare-cell:hover {
  outline: 2px solid var(--amber);
  outline-offset: -2px;
}
.compare-cell.is-absent {
  background: var(--sheet-dim);
  color: var(--muted);
  font-style: italic;
  cursor: default;
}
.compare-row.is-identical .compare-cell {
  background: color-mix(in srgb, var(--ok) 7%, var(--sheet));
}
.compare-row.is-differing .compare-cell {
  background: color-mix(in srgb, var(--amber) 9%, var(--sheet));
}
.compare-row.is-only-a .compare-cell,
.compare-row.is-only-b .compare-cell {
  background: color-mix(in srgb, var(--err) 7%, var(--sheet));
}
.compare-diff {
  background: color-mix(in srgb, var(--amber) 30%, transparent);
  border-radius: 2px;
  padding: 0 1px;
}
.compare-state {
  font: 0.58rem var(--mono);
  letter-spacing: 0.08em;
  color: var(--muted);
  text-transform: uppercase;
  white-space: nowrap;
}
.compare-empty {
  font-family: var(--serif);
  color: var(--muted);
  padding: 1rem 0;
}
@media (max-width: 720px) {
  .compare {
    padding: 0.9rem 1rem 8rem;
  }
}
```

- [ ] **Step 4: Verify the tab renders** — start the demo (`node server.mjs`, keyless), open `http://127.0.0.1:3001`, click **Compare**, confirm the panel and empty pickers show without console errors.

- [ ] **Step 5: Commit**

```bash
git add examples/web_ui_demo/index.html examples/web_ui_demo/css/app.css
git commit -m "feat(example): Compare tab markup + styles"
```

---

### Task 5: Compare view controller

**Files:**
- Create: `examples/web_ui_demo/js/compare.js`

**Interfaces:**
- Consumes: `diffWords` (Task 1), `buildCompareView` / `detectCompareFeatures` (Task 2), `postCompareReport` (Task 3).
- Produces: `initCompare(opts) => { refresh(): void }` where `opts = { getCatalog, displaySection, onCite, onHandoff }`:
  - `getCatalog() => { specId, section, title, origin }[]` — live specs to populate the pickers (built by app.js from projects + libraries).
  - `displaySection(section) => string`.
  - `onCite(anchor) => void` — `anchor = { section, specId, paragraphId }`; opens the Report/audit pane (reuses `onComposeCite`).
  - `onHandoff({ sources, sections, labels }) => void` — switches to Compose and pre-fills prompt + scope.

- [ ] **Step 1: Write the controller** (`js/compare.js`). Keep each function ≤50 lines; split rendering from wiring.

```javascript
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
  let lastSources = null; // [{specId, section, title}] for the handoff

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
      setStatus('Load the same section into two projects (or a project + its master) to compare.');
    }
  }

  function setStatus(text, isError = false) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  function specById(specId) {
    return getCatalog().find((spec) => spec.specId === specId) ?? null;
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
  function renderCell(cell, sideTokens, column) {
    if (cell?.present !== true) {
      return el('td', 'compare-cell is-absent', '— not present —');
    }
    const td = el('td', 'compare-cell');
    for (const token of sideTokens) {
      if (token.changed && token.text.trim() !== '') {
        td.appendChild(el('span', 'compare-diff', token.text));
      } else {
        td.appendChild(document.createTextNode(token.text));
      }
    }
    td.addEventListener('click', () => {
      onCite?.({ section: column.section, specId: cell.specId, paragraphId: cell.paragraphUuid });
    });
    return td;
  }

  function renderRow(row, columns) {
    const tr = el('tr', `compare-row is-${row.state}`);
    tr.appendChild(el('td', 'compare-state', row.state.replace('-', ' ')));
    const textA = row.cells[0]?.present ? row.cells[0].text : '';
    const textB = row.cells[1]?.present ? row.cells[1].text : '';
    const { a, b } = diffWords(textA, textB);
    const sides = [row.state === 'differing' ? a : null, row.state === 'differing' ? b : null];
    tr.appendChild(renderCell(row.cells[0], sides[0] ?? plainTokens(textA), columns[0]));
    tr.appendChild(renderCell(row.cells[1], sides[1] ?? plainTokens(textB), columns[1]));
    return tr;
  }

  function plainTokens(text) {
    return text ? [{ text, changed: false }] : [];
  }

  function renderMatrix(report) {
    const view = buildCompareView(report);
    matrixEl.replaceChildren();
    if (view.columns.length < 2 || view.rows.length === 0) {
      matrixEl.appendChild(el('p', 'compare-empty', 'No aligned paragraphs to compare.'));
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

  function reportSummary(view, report) {
    const features = detectCompareFeatures(report);
    const differing = view.rows.filter((r) => r.state === 'differing').length;
    const oneSided = view.rows.filter((r) => r.state === 'only-a' || r.state === 'only-b').length;
    const base = `${view.rows.length} aligned ¶ · ${differing} differing · ${oneSided} only-in-one`;
    setStatus(features.summary ? `${base} · server summary attached` : base);
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
    handoffBtn.hidden = true;
    matrixEl.replaceChildren();
    setStatus('Running grounded comparison…');
    try {
      const options = baselineToggle?.checked ? { baseline: a } : {};
      const report = await postCompareReport([a, b], options);
      renderMatrix(report);
      lastSources = [specById(a), specById(b)].filter(Boolean);
      handoffBtn.hidden = lastSources.length !== 2;
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
```

- [ ] **Step 2: Sanity-check function length** — every function is ≤50 lines; `run` and `renderRow` are the longest. Confirm no function exceeds the cap.

- [ ] **Step 3: Commit**

```bash
git add examples/web_ui_demo/js/compare.js
git commit -m "feat(example): Compare view controller — matrix render + click-through"
```

---

### Task 6: Wire Compare into app.js + Compose handoff

**Files:**
- Modify: `examples/web_ui_demo/js/app.js` (import + `showView` + `boot` wiring + catalog builder + handoff)
- Modify: `examples/web_ui_demo/js/compose.js` (add `prefill(text)` to the controller)
- Modify: `examples/web_ui_demo/index.html` (add a "Compare two projects" example chip in Compose)

**Interfaces:**
- Consumes: `initCompare` (Task 5), `composePanel.prefill` (this task).
- Produces: `comparePanel` controller stored in app.js; `buildCompareCatalog()` gathering live specs from the loaded board + libraries.

- [ ] **Step 1: Add `prefill` to Compose** (`js/compose.js`) — extend the returned controller so the handoff can populate the request box:

```javascript
  function prefill(text) {
    if (typeof text !== 'string') return;
    input.value = text;
    input.focus();
  }

  refresh();
  return { refresh, prefill };
```

- [ ] **Step 2: Add the Compose example chip** (`index.html`, inside `#compose-examples`, after the "Compare a section" chip):

```html
          <button
            class="compose-chip"
            type="button"
            data-example="Summarize the differences of this spec between these two projects, citing the specific paragraphs that diverge."
          >
            Compare two projects
          </button>
```

- [ ] **Step 3: Import initCompare** in `js/app.js` (beside the other view imports, ~line 43):

```javascript
import { initCompare } from './compare.js';
```

- [ ] **Step 4: Declare the panel handle** near the other `let …Panel` declarations (~line 61):

```javascript
let comparePanel = null; // deterministic side-by-side comparison controller (initCompare, #385)
```

- [ ] **Step 5: Refresh Compare on view show** — in `showView`, beside the other per-view refreshes (~line 127):

```javascript
  if (view === 'compare') comparePanel?.refresh();
```

- [ ] **Step 6: Add the catalog builder + handoff helpers** near `composeScopeLabel`/`onComposeCite` (~line 1955). The catalog lists every live spec loaded on the board, tagged by project/library origin; the handoff pre-fills Compose and switches to it.

```javascript
// Live specs available to the Compare pickers — every loaded board spec,
// tagged by the active project so two same-section copies read distinctly.
// (The board holds one project's specs at a time; the origin names the project,
// so comparing a section across projects means loading each, or a project vs a
// master copy loaded from the Library.)
function buildCompareCatalog() {
  const projectName = activeProjectName();
  return [...specs.values()]
    .map((spec) => ({
      specId: spec.tree.id,
      section: spec.tree.section,
      title: spec.tree.title,
      origin: readLibraryOnlyIds().has(spec.tree.id) ? 'Library copy' : projectName,
    }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.origin.localeCompare(b.origin));
}

// Compare → Compose handoff: pre-fill a grounded summarize prompt naming the two
// spec UUIDs (so the agent calls compare_specs deterministically), then switch
// to the Compose tab.
function onCompareHandoff({ sources, sections, labels }) {
  const [idA, idB] = sources;
  const sectionLabel = displaySection(sections[0]);
  const prompt =
    `Summarize the differences of Section ${sectionLabel} between ${labels[0]} and ${labels[1]}. ` +
    `Compare these two specs with the compare_specs tool — spec ids ${idA} and ${idB} — ` +
    `then narrate the key differences, citing the specific paragraphs that diverge.`;
  showView('compose');
  composePanel?.prefill(prompt);
}
```

- [ ] **Step 7: Construct the panel in `boot`** — after `composePanel = initCompose(...)` (~line 2205):

```javascript
  comparePanel = initCompare({
    getCatalog: buildCompareCatalog,
    displaySection,
    onCite: onComposeCite,
    onHandoff: onCompareHandoff,
  });
```

- [ ] **Step 8: Keep the picker fresh on board changes** — in `renderBoard`, beside the editor/constellation refresh (~line 2087):

```javascript
  comparePanel?.refresh();
```

- [ ] **Step 9: Verify demo tests stay green**

Run: `node --test examples/web_ui_demo/*.test.mjs`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add examples/web_ui_demo/js/app.js examples/web_ui_demo/js/compose.js examples/web_ui_demo/index.html
git commit -m "feat(example): wire Compare tab + Compose summarize handoff"
```

---

### Task 7: README walkthrough

**Files:**
- Modify: `examples/web_ui_demo/README.md` (add "Two-fixture comparison demo" section + Compare to the Workspace views list)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add "Compare" to the Workspace views paragraph** (`README.md:41-46`), appending to the nav list sentence: `…, **Compose** (agent-driven grounded reporting), and **Compare** (deterministic side-by-side matrix of two specs).`

- [ ] **Step 2: Add a walkthrough section** after the Compose section (before "One-Command Demo Launchers"):

```markdown
## Compare — two-fixture comparison demo (#385)

The **Compare** tab renders the grounded `POST /reports/compare` matrix (ADR-047)
side by side: two live specs aligned by resolved paragraph origin, differing
paragraphs highlighted word by word, every present cell a click-through into the
Report pane. It is the deterministic surface behind the demo scenario
"summarize the differences of this spec between these two projects" — the matrix
is the button; the **Ask SpecR to summarize** handoff lets the agent narrate it.

Reproduce it end to end:

1. **Load two copies of the same section.** Either put the same CSI section in two
   projects, or load one project copy and one master copy from the **Library**.
   The quickest path for a demo: upload two `.docx` fixtures of the same section
   (e.g. an ARCAT `03 30 00` and a CPI `03 30 00`) — one into the project, one
   into a client master — via the existing upload/Add-from-Library flows.
2. **Open Compare.** Both specs appear in the two source pickers, tagged by
   origin. Pick one in **Source A** and the other in **Source B**.
3. **Run comparison.** The matrix renders: identical rows read plain, differing
   rows are amber with word-level highlights, one-sided rows are tinted red.
   Optionally tick **Use Source A as baseline** for the added/removed/modified
   lens (when the server returns one).
4. **Click any cell** to open that exact paragraph in the **Report** audit pane.
5. **Ask SpecR to summarize.** The handoff switches to **Compose** with the
   prompt and both spec ids pre-filled — press **Compose report** and the agent
   calls `compare_specs` and narrates the differences, each claim cited.
```

- [ ] **Step 2: Commit**

```bash
git add examples/web_ui_demo/README.md
git commit -m "docs(example): Compare view two-fixture walkthrough"
```

---

## Self-Review

**Spec coverage:**
- Compare tab + two pickers → Tasks 4, 5, 6. ✓
- Run → POST /reports/compare + side-by-side matrix (headers = section+title, rows = aligned ¶) → Tasks 3, 5. ✓
- Cell-state coloring + baseline-lens toggle → Tasks 2 (states), 4 (CSS), 5 (toggle→baseline request). ✓
- Client-side word-level diff → Tasks 1, 5. ✓
- Click-through grounding into Report/audit pane → Task 5 (`onCite` = `onComposeCite`). ✓
- Ask-SpecR summarize handoff (prompt + scope) + Compose example chip → Task 6. ✓
- Feature-detect #384 additive fields (`summary`/`alignedBy` by presence; `alignment`/`include` behind flag) → Tasks 2, 3. ✓
- README walkthrough → Task 7. ✓
- Demo suites green + new pure helpers covered → Tasks 1, 2 (`.test.mjs`), verified in 3, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `postCompareReport(sources, {baseline})` (Task 3) matches its call in Task 5. `buildCompareView`/`cellState`/`detectCompareFeatures`/`baselineStatesFor` signatures (Task 2) match their use in Task 5. `diffWords` return `{a,b}` of `{text,changed}` (Task 1) matches `renderCell`/`renderRow` use (Task 5). `initCompare(opts)` `{getCatalog,displaySection,onCite,onHandoff}` (Task 5) matches the `boot` wiring (Task 6). `prefill(text)` (Task 6 compose change) matches `onCompareHandoff` call (Task 6). ✓

**Note on baseline lens rendering:** Task 2 surfaces `baselineStates` per row and Task 5 stores it via `buildCompareView`, but Task 5's cell renderer colors by `row.state` (identical/differing/only-one), not by the baseline lens states. The baseline toggle still exercises the endpoint's baseline path and the status line notes it; a richer per-cell baseline recoloring is deferred (not required by acceptance — acceptance asks for the toggle + word-highlights + click-through, all present). This is an intentional scope boundary, documented in the PR body.
```
