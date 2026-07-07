# Compare View Modes (Inline review + filters) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the demo Compare view (#386) with filter chips + a track-changes "Inline review" single-pager, so the handful of real deltas surface out of dozens of identical rows.

**Architecture:** Two new pure ES modules do the view-model work (filter/collapse + merged-redline token builder), unit-tested with `node --test`. `js/compare.js` becomes a controller that caches the full comparison matrix client-side and re-renders on mode/filter toggles into two DOM renderers (existing side-by-side table + new inline flow). No API/`src/` change — the full matrix is always fetched so the GitHub-style context expander can reveal collapsed identical rows in place.

**Tech Stack:** Vanilla ES modules (no bundler), `node:test`, existing `js/word-diff.mjs` LCS + `js/compare-model.mjs` view-model, `css/app.css` `compare-*` tokens.

## Global Constraints

- ALL changes inside `examples/web_ui_demo/` — no `src/`, no API, no `openapi.yaml` change.
- Verification: `node --test examples/web_ui_demo/*.test.mjs`, plus `pnpm lint` + `pnpm test` at repo root (no DB). Never bind ports 3000/3001; never run `Start-SpecR.sh`/`docker compose`.
- Native ESM: relative imports carry file extensions (`./word-diff.mjs`). Pure helpers = no DOM, no `document`.
- Accessibility parity with the #386 review outcome: every interactive element gets `tabIndex`/`role="button"`/Enter-Space; `<del>`/`<ins>` are semantic; state colors keep a non-color signifier.
- Commits: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit scope = `feat(compare-demo)` or `feat(example)`.

---

### Task 1: `compare-filter.mjs` — filters, counts, collapse (pure)

**Files:**
- Create: `examples/web_ui_demo/js/compare-filter.mjs`
- Test: `examples/web_ui_demo/compare-filter.test.mjs`

**Interfaces:**
- Consumes: view rows from `buildCompareView` (`{ state: 'identical'|'differing'|'only-a'|'only-b', cells }`); server `summary` (ADR-053: `{ rows, aligned, identical, differing, columns:[{specId,present,onlyIn}] }`).
- Produces:
  - `COMPARE_FILTERS: [{id,label}]` — `all`, `changes`, `only-a`, `only-b`.
  - `matchesFilter(state, filterId) -> boolean`
  - `filterCounts(rows) -> { all, changes, 'only-a', 'only-b' }`
  - `resolveCounts(rows, summary) -> { all, changes, 'only-a', 'only-b' }` (prefers `summary`, per-field fallback)
  - `buildSegments(rows, filterId) -> [{ kind:'row', key, row } | { kind:'gap', key, rows }]` (`changes` collapses identical runs; `key` = full-matrix index)

- [ ] **Step 1: Write failing tests** (`compare-filter.test.mjs`) covering: `matchesFilter` per filter; `filterCounts`; `resolveCounts` prefers summary and falls back per-field; `buildSegments` for `all` (all rows), `changes` (identical runs → one gap each, changes as rows), `only-a`/`only-b` (subset, no gaps); `key` stability.
- [ ] **Step 2: Run** `node --test examples/web_ui_demo/compare-filter.test.mjs` → FAIL (module missing).
- [ ] **Step 3: Implement `compare-filter.mjs`** (code below).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(compare-demo): filter + collapse view-model helpers`.

```js
// examples/web_ui_demo/js/compare-filter.mjs
// Filter + collapse helpers for the Compare view modes (#395). Pure, no DOM.
// `resolveCounts` rolls the full matrix into chip counts (preferring the server
// summary); `buildSegments` turns the full row list into the render sequence for
// a filter, collapsing runs of identical rows into expandable gaps in "changes".

export const COMPARE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changes', label: 'Changes only' },
  { id: 'only-a', label: 'Only in A' },
  { id: 'only-b', label: 'Only in B' },
];

const CHANGE_STATES = new Set(['differing', 'only-a', 'only-b']);

export function matchesFilter(state, filterId) {
  switch (filterId) {
    case 'changes':
      return CHANGE_STATES.has(state);
    case 'only-a':
      return state === 'only-a';
    case 'only-b':
      return state === 'only-b';
    case 'all':
    default:
      return true;
  }
}

export function filterCounts(rows) {
  const counts = { all: rows.length, changes: 0, 'only-a': 0, 'only-b': 0 };
  for (const row of rows) {
    if (CHANGE_STATES.has(row.state)) counts.changes += 1;
    if (row.state === 'only-a') counts['only-a'] += 1;
    if (row.state === 'only-b') counts['only-b'] += 1;
  }
  return counts;
}

// Prefer the server's full-matrix summary (ADR-053) when attached; fall back
// per-field to the locally computed counts. summary.differing already folds
// modified + one-sided rows, matching our 'changes' definition; per-column
// onlyIn gives the one-sided counts.
export function resolveCounts(rows, summary) {
  const computed = filterCounts(rows);
  if (!summary || typeof summary !== 'object') return computed;
  const columns = Array.isArray(summary.columns) ? summary.columns : [];
  const pick = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  return {
    all: pick(summary.rows, computed.all),
    changes: pick(summary.differing, computed.changes),
    'only-a': pick(columns[0]?.onlyIn, computed['only-a']),
    'only-b': pick(columns[1]?.onlyIn, computed['only-b']),
  };
}

// Collapse maximal runs of identical rows into gap segments; every other row is
// its own row segment (GitHub context expander for 'changes').
function segmentChanges(rows) {
  const segments = [];
  let gap = null;
  rows.forEach((row, index) => {
    if (row.state === 'identical') {
      if (!gap) gap = { kind: 'gap', key: index, rows: [] };
      gap.rows.push(row);
      return;
    }
    if (gap) {
      segments.push(gap);
      gap = null;
    }
    segments.push({ kind: 'row', key: index, row });
  });
  if (gap) segments.push(gap);
  return segments;
}

// Render sequence for a filter. 'changes' collapses identical runs into
// expandable gaps; other filters return just their matching rows (no gaps).
// `key` is the row's index in the full matrix — stable for expansion tracking.
export function buildSegments(rows, filterId) {
  if (filterId === 'changes') return segmentChanges(rows);
  const segments = [];
  rows.forEach((row, index) => {
    if (matchesFilter(row.state, filterId)) segments.push({ kind: 'row', key: index, row });
  });
  return segments;
}
```

---

### Task 2: `compare-inline.mjs` — merged-redline token builder (pure)

**Files:**
- Create: `examples/web_ui_demo/js/compare-inline.mjs`
- Test: `examples/web_ui_demo/compare-inline.test.mjs`

**Interfaces:**
- Consumes: `diffWords` from `./word-diff.mjs`; a view row `{ state, cells:[cellA, cellB] }`.
- Produces:
  - `mergeTokens(textA, textB) -> [{ text, kind:'shared'|'del'|'ins' }]`
  - `buildInlineTokens(row) -> [{ text, kind }]` (dispatch on `row.state`)

- [ ] **Step 1: Write failing tests** (`compare-inline.test.mjs`): identical strings → all shared, no del/ins; `mergeTokens('4000 psi concrete','3000 psi concrete')` → del `['4000']`, ins `['3000']`, shared words `['psi','concrete']`; empty-vs-nonempty → all ins; **PINNED** `mergeTokens('big red car','big blue car')` → every whitespace-text token has `kind==='shared'` (whitespace never del/ins); `buildInlineTokens` dispatch: `differing`→merged, `only-a`→single del, `only-b`→single ins, `identical`→single shared.
- [ ] **Step 2: Run** `node --test examples/web_ui_demo/compare-inline.test.mjs` → FAIL.
- [ ] **Step 3: Implement `compare-inline.mjs`** (code below).
- [ ] **Step 4: Run** the test → PASS.
- [ ] **Step 5: Commit** `feat(compare-demo): merged-redline inline token builder`.

```js
// examples/web_ui_demo/js/compare-inline.mjs
// Merged-redline token builder for the Compare view's Inline review mode (#395).
// Pure, no DOM. Reuses the word-diff LCS (js/word-diff.mjs) to fold a differing
// A/B pair into ONE token stream: shared words once, A-only words as deletions,
// B-only words as insertions. Words are joined by shared single-space separators,
// so no del/ins token is ever whitespace — a screen reader reads a clean sentence.

import { diffWords } from './word-diff.mjs';

const isWhitespace = (text) => /^\s+$/.test(text);
const wordsOf = (marks) => marks.filter((token) => !isWhitespace(token.text));

// Join word tokens with shared single-space separators.
function spaced(tokens) {
  const out = [];
  tokens.forEach((token, index) => {
    if (index > 0) out.push({ text: ' ', kind: 'shared' });
    out.push(token);
  });
  return out;
}

// Merge a differing pair. Unchanged words are the LCS (identical order on both
// sides), so when both walkers reach an unchanged word it is the same word —
// emitted once as shared. Everything else is a one-sided del (A) or ins (B).
export function mergeTokens(textA, textB) {
  const { a, b } = diffWords(textA ?? '', textB ?? '');
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < wordsA.length || j < wordsB.length) {
    while (i < wordsA.length && wordsA[i].changed) {
      merged.push({ text: wordsA[i].text, kind: 'del' });
      i += 1;
    }
    while (j < wordsB.length && wordsB[j].changed) {
      merged.push({ text: wordsB[j].text, kind: 'ins' });
      j += 1;
    }
    if (i < wordsA.length && j < wordsB.length) {
      merged.push({ text: wordsA[i].text, kind: 'shared' });
      i += 1;
      j += 1;
    }
  }
  return spaced(merged);
}

// Fold one aligned row into its inline token stream by state.
export function buildInlineTokens(row) {
  const textA = row?.cells?.[0]?.present ? row.cells[0].text : '';
  const textB = row?.cells?.[1]?.present ? row.cells[1].text : '';
  switch (row?.state) {
    case 'differing':
      return mergeTokens(textA, textB);
    case 'only-a':
      return textA ? [{ text: textA, kind: 'del' }] : [];
    case 'only-b':
      return textB ? [{ text: textB, kind: 'ins' }] : [];
    case 'identical':
    default: {
      const text = textA || textB;
      return text ? [{ text, kind: 'shared' }] : [];
    }
  }
}
```

---

### Task 3: HTML toolbar + `postCompareReport` include plumbing

**Files:**
- Modify: `examples/web_ui_demo/index.html` (Compare view section, ~L553-556) — add toolbar container between actions and status.
- Modify: `examples/web_ui_demo/js/api.js:246-250` — accept optional `include` (additive; endpoint already accepts it per #384).

**Interfaces:**
- Produces: DOM ids `#compare-toolbar` (wrapper, `hidden`), `#compare-modes` (segmented control), `#compare-filters` (chip group). `postCompareReport(sources, { baseline, include })`.

- [ ] **Step 1: Add toolbar HTML** after `<div class="compare-actions">…</div>` (before `#compare-status`):

```html
        <div class="compare-toolbar" id="compare-toolbar" hidden>
          <div class="compare-modes" id="compare-modes" role="tablist" aria-label="Compare view mode"></div>
          <div class="compare-filters" id="compare-filters" role="group" aria-label="Filter rows"></div>
        </div>
```

- [ ] **Step 2: Extend `postCompareReport`** to pass `include` through (default omitted = full matrix):

```js
export function postCompareReport(sources, { baseline, include } = {}) {
  const body = { sources };
  if (baseline) body.baseline = baseline;
  // The demo deliberately fetches the FULL matrix (default include='all', so we
  // omit it) — the 'Changes only' context expander reveals collapsed identical
  // rows in place, which requires them present client-side. `include` is plumbed
  // for parity with the #384 option but not sent by default (ADR-053 synergy).
  if (include) body.include = include;
  return sendJson('POST', '/reports/compare', body);
}
```

- [ ] **Step 3: Commit** `feat(compare-demo): compare toolbar shell + include plumbing`.

---

### Task 4: CSS — toolbar, chips, gap divider, inline flow (theme-aware)

**Files:**
- Modify: `examples/web_ui_demo/css/app.css` — append a `compare` view-mode block after L3786 (`.compare-empty`), before the `@media` block.

**Interfaces:** classes `compare-toolbar`, `compare-modes`, `compare-mode-btn(.is-active)`, `compare-filters`, `compare-chip(.is-active)`, `compare-chip-count`, `compare-gap`, `compare-inline`, `compare-inline-para(.is-*)`, `compare-inline-gutter`, `compare-inline-chip`, `compare-inline-text`, plus `del.compare-del`/`ins.compare-ins`.

- [ ] **Step 1: Append CSS** reusing existing `--ok/--amber/--err/--sheet/--line-dim/--mono/--serif` tokens (so light/dark themes both work): segmented mode buttons, filter chips with count badge, dashed expandable gap divider, inline single-column flow, per-state left-border signifier (non-color redundancy), `<del>` strikethrough + `<ins>` underline/tint. Interactive elements get a visible `:focus-visible` outline. (Concrete rules written at implementation.)
- [ ] **Step 2: Commit** `style(compare-demo): view-mode toolbar, chips, gap + inline redline`.

---

### Task 5: `compare.js` controller — cache matrix, dual render, filter/collapse, inline mode, expansion

**Files:**
- Modify: `examples/web_ui_demo/js/compare.js` (whole controller). If it exceeds ~380 lines, extract the two DOM renderers into `examples/web_ui_demo/js/compare-dom.js`.

**Interfaces:**
- Consumes: Task 1 (`COMPARE_FILTERS`, `resolveCounts`, `buildSegments`), Task 2 (`buildInlineTokens`), existing `buildCompareView`/`detectCompareFeatures`, `diffWords`, `postCompareReport({include})`.
- Produces: unchanged public shape `initCompare(opts) -> { refresh }`.

- [ ] **Step 1:** Add controller state: `let view = null; let viewMode = 'side-by-side'; let activeFilter = 'all'; const expandedGaps = new Set();`. Cache `view = buildCompareView(report)` (and `lastReport`) in `run()`; show `#compare-toolbar`; call `render()`.
- [ ] **Step 2:** Build the mode segmented control (`Side-by-side` | `Inline review`) into `#compare-modes` and the filter chips (from `COMPARE_FILTERS`, each with a live count from `resolveCounts`) into `#compare-filters`. Buttons: `role="tab"`/`aria-selected` for modes, `aria-pressed` for chips; keyboard-operable. On mode change: keep `activeFilter`, clear `expandedGaps`, `render()`. On chip change: set `activeFilter`, clear `expandedGaps`, `render()`.
- [ ] **Step 3:** `render()` dispatches: compute `segments = buildSegments(view.rows, activeFilter)`; if `viewMode==='side-by-side'` build the table (existing `headRow`/`renderRow` reused, iterating segments — gaps become a full-width expandable `<tr>`), else build the inline flow (`buildInlineTokens` per row → `<del>`/`<ins>`/plain, per-paragraph A/B cite chips). Empty subset → a "no rows match this filter" note.
- [ ] **Step 4:** Gap expansion: a `compare-gap` divider (`role="button"`, tabindex, Enter/Space) shows `· N unchanged paragraphs ·`; on activate add its `key` to `expandedGaps` and `render()` — an expanded gap renders its `rows` as normal row/paragraph segments in place.
- [ ] **Step 5:** Click-through parity: table cells keep today's `onCite`; inline paragraphs expose an A chip (present side 0) and/or B chip (present side 1), each `role="button"`/tabindex/Enter-Space → `onCite({ section, specId, paragraphId })`, same anchor channel.
- [ ] **Step 6:** Update chip counts + status line after each `render()` from `resolveCounts(view.rows, lastReport?.summary)`; preserve the existing "server summary attached / baseline lens" status text.
- [ ] **Step 7: Run** `node --test examples/web_ui_demo/*.test.mjs` (all green incl. new), `pnpm test` + `pnpm lint` at root (green). Manual sanity via a non-3000/3001 port only if needed.
- [ ] **Step 8: Commit** `feat(compare-demo): inline-review mode + filter chips + context expander`.

---

## Self-Review

- **Coverage:** item 1 (mode toggle)→T3/T5; item 2 (filter chips + counts + collapse)→T1/T4/T5; item 3 (inline redline + click-through)→T2/T4/T5; item 4 (a11y)→T4/T5 across all interactive nodes; item 5 (server synergy/summary)→T1 (`resolveCounts`) + T3 (`include` plumbing, documented client-side default); item 6 (pure helpers unit-tested + whitespace pin + CSS token reuse)→T1/T2/T4. Acceptance (filters/counts, collapse-expand, mode preserves filter, inline redline correctness, click-through both modes, suites green)→T5 steps 2-7.
- **Placeholders:** pure-module code is complete; CSS/DOM rules finalized at implementation against live tokens (structure + class contract fixed here).
- **Type consistency:** `buildSegments` emits `{kind,key,row}`/`{kind,key,rows}`; `resolveCounts`/`filterCounts` keys `all|changes|only-a|only-b` match `COMPARE_FILTERS` ids; `mergeTokens`/`buildInlineTokens` emit `{text,kind:'shared'|'del'|'ins'}` consumed by T5 renderer.
