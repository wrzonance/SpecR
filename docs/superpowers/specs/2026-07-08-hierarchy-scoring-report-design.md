# Per-paragraph hierarchy-scoring report — design

**Issue:** #424 · **Relates to:** ADR-055 (hierarchy-inference confidence), pressure-phase WS2 · **Date:** 2026-07-08

## Goal

Give a human a worst-first, filterable view of **every scored paragraph's** hierarchy-inference
confidence for a stored spec — the "report **before** the gate" that lets a person eyeball inference
quality before WS3 automates a corpus pass/fail. One demonstrable change: a stored spec's per-paragraph
scores become retrievable (REST + MCP) and browsable (demo).

## Context (what already exists)

- **The scores already exist per paragraph for a stored spec.** `getSpec`
  (`src/db/queries/specs.ts:175`) derives `meta.inference` at read time from the persisted
  `signal_provenance` JSONB (ADR-055), so `GET /specs/:id` already returns
  `{ confidence, signalUsed, agreed, evidence }` on every scored structural node. Nothing about the
  inference engine, parser, worker, or DB changes.
- **`summarizeHierarchy`** (`src/lib/hierarchy-summary.ts`) already walks a tree and returns
  `{ counts: { scored, unscored, belowThreshold }, unscoredReason?, lowConfidence[] }`, worst-first,
  and is shared by the REST onboarding report and the MCP `get_onboarding_report` tool. It returns
  **only** the below-threshold triage set — not the full per-paragraph distribution.
- **The demo** (`examples/web_ui_demo/`) already fetches the tree via `getSpecTree()` (`js/api.js:52`)
  and has a two-pane "Report" tab (`js/audit.js`) — a findings list beside the spec, click-to-jump —
  built on `expandAncestors` (tree.js) + the hover-walker (popover.js). This is the layout to mirror.
- **Labels** are render-derived: `getLabel(nodeType, index, partNumber)` (canonical, in the AST barrel
  and re-exported via `generator/markdown.ts`) with sibling counting via `consumesNumber`
  (`src/ast/labels.ts`). No stored label exists; there is **no** existing node→CSI-label walk to reuse.

## Decisions (locked in brainstorming)

1. **Architecture:** server-side, shared, tested capability **+** demo view — not demo-only. The
   scoring becomes a first-class module boundary (REST + MCP), so it is testable and reusable.
2. **Coverage:** the report returns **all scored** structural paragraphs, worst-confidence-first, plus
   the aggregate counts and `unscoredReason`. Unscored + non-structural nodes are **counted but not
   listed**. The demo filters client-side.
3. **Entry richness:** **rich, human-readable** — enough to eyeball without opening the spec. Not the
   raw signal-provenance dump.
4. **Demo view:** a new **"Scoring"** tab, **two-pane** (worst-first list left, spec right,
   click-to-jump), mirroring the `audit.js` Report tab.

## Architecture

```
getSpec (existing, derives meta.inference)
        │  tree + source
        ▼
buildHierarchyReport(tree, source, threshold?)   ← src/lib/hierarchy-report.ts (NEW, shared)
        │        ▲
        │        └── walkScored(tree)  ← independent ordinal-aware walk (summarizeHierarchy untouched)
        ▼
HierarchyReport { counts, unscoredReason?, paragraphs[] }
        │
   ┌────┴─────────────────────┐
   ▼                          ▼
GET /specs/:id/hierarchy-report   MCP get_hierarchy_report (read tier, contract-bound)
   │                          │
   └──────────┬───────────────┘
              ▼
   demo "Scoring" tab (js/scoring.js, two-pane, reuse audit.js machinery)
```

## Component 1 — scoring module (`src/lib/hierarchy-report.ts`)

### Data shapes

```typescript
export interface ScoredParagraph {
  readonly nodeId: string;
  readonly nodeType: NodeType;
  readonly ilvl: number;              // nodeTypeToNormalizedIlvl(nodeType)
  readonly label: string;             // canonical getLabel — e.g. "1.2.A"
  readonly preview: string;           // node text, truncated to PREVIEW_MAX chars (~120)
  readonly confidence: number;
  readonly signalUsed: SignalNumber;
  readonly agreed: readonly SignalNumber[];
  readonly evidence: readonly string[];
  readonly conflicts?: readonly SignalConflict[];   // omitted when none (never []).
}

export interface HierarchyReport {
  readonly counts: { readonly scored: number; readonly unscored: number; readonly belowThreshold: number };
  readonly unscoredReason?: string;   // same semantics as summarizeHierarchy
  readonly paragraphs: readonly ScoredParagraph[];   // ALL scored, worst-first
}

export function buildHierarchyReport(
  tree: SpecTree,
  source: string | null,
  threshold?: number,       // default HIERARCHY_REVIEW_THRESHOLD (only affects counts.belowThreshold)
): HierarchyReport;
```

### Consistency without refactoring `summarizeHierarchy`

> Revised during planning. An earlier draft had `summarizeHierarchy` consume one shared `walkScored`;
> that was reversed — see the plan's "DRY without the knot" note. The final decision is below.

- `buildHierarchyReport` uses a private **`walkScored(tree)`** that walks parts once, prunes vanished
  subtrees (the existing `vanish ∪ descendants` rule), skips `NON_STRUCTURAL` types, and yields a rich
  entry per scored node **plus** tallies of `scored`/`unscored`. Label + preview are computed in this walk.
- `buildHierarchyReport` = `walkScored` → sort all entries worst-first (tie-break `nodeId.localeCompare`)
  → attach counts + `unscoredReason`.
- **`summarizeHierarchy` is left untouched.** Its walk is a flat tally-recurse; the report's must be
  ordinal-aware (it tracks per-tier sibling indices to compute labels). Folding them into one
  parameterized walk would serve neither cleanly and would perturb a shipped contract (the onboarding
  report + MCP `get_onboarding_report`). Instead, a **counts-equivalence invariant test** pins
  `buildHierarchyReport(...).counts` deep-equal to `summarizeHierarchy(...).counts` (and the
  below-threshold subset), so the two independent implementations can never silently drift.

### Labels — the one real risk

Labels must be produced by the canonical `getLabel` + `consumesNumber` primitives, never reimplemented.
`walkScored` tracks the per-tier number-consuming sibling index exactly as `renderMarkdown`'s
`renderChildren` does (article labels also need the enclosing part number). This is the sole piece of
non-trivial new logic and the sole drift risk.

**Mitigation (becomes invariant test #1):** for a fixture, every `ScoredParagraph.label` equals the
label `renderMarkdown` emits for the same node. If the renderer's counting changes, this test fails.

## Component 2 — REST endpoint

- **`GET /specs/:id/hierarchy-report`** → `ApiResponse<HierarchyReport>`. Read-only.
- Handler validates `:id` (invalid → 400), loads via the existing `getSpec` path (missing → typed 404),
  obtains the spec's `source` label the same way the onboarding report does (`getSpecSource`), builds
  the report, returns 200. No internals leak; boundary-typed errors as in `onboarding.ts`.
- Registered in `router.ts` alongside the other `/specs/:id/*` GET routes.
- **`openapi.yaml` updated in the same PR:** the path + `HierarchyReport` and `ScoredParagraph` schemas.
  The contract gate (`contract.integration.test.ts`) enforces route↔spec↔response-schema coverage.

## Component 3 — MCP tool

- **`get_hierarchy_report`**, **read** tier (`capabilities.ts`) → exposed by default.
- Contract-bound to the REST op in `contract-map.ts` (ADR-044 INV-1/2/3); the MCP contract test goes red
  if the route exists without a mapped tool.
- Input `{ specId: z.uuid() }` (Zod v4). Never throws → `{ isError: true, content: [...] }` on failure.
  Imports DB functions from `../db/index.js` only. Returns the same `HierarchyReport` payload.

## Component 4 — demo "Scoring" tab

- **New `examples/web_ui_demo/js/scoring.js`** + a nav/tab entry + `getHierarchyReport(specId)` in
  `js/api.js`. Styling via existing demo CSS (`css/app.css`); no framework.
- **Two-pane**, mirroring `audit.js`:
  - **Left:** worst-first list, one row per `ScoredParagraph` — confidence badge (color-banded), label,
    truncated preview, and a signals line (`signalUsed` won; `agreed`). Filter control:
    `all · <50% · <60% (threshold) · document-order`. (`<60%` uses the report's `belowThreshold` band;
    document-order re-sorts by the paragraphs' natural position.)
  - **Right:** the spec (reuse the existing tree render). Clicking a row calls `expandAncestors` +
    scrolls/highlights `[data-node-id="…"]`, exactly as `audit.js` drives its finding→paragraph jump.
  - Header shows `counts` and, when `unscored > 0`, the `unscoredReason` (so a UFGS/pre-provenance spec
    reads as "unscored by design", not "broken").
- Demo tests live beside the others (`*.test.mjs`): report-model shaping + filter behavior.

## Error handling

Boundary-typed throughout. Invalid id → 400; missing spec → 404 (typed, via `getSpec`); unexpected → 500.
Stack traces never leave the process. MCP mirrors via `{ isError }`. Zod-validate the MCP input at the edge.

## Invariants → tests

1. **Label non-drift:** `ScoredParagraph.label` == `renderMarkdown`'s label for each node (fixture).
2. **Shared-walk equivalence:** `buildHierarchyReport(...).counts` and the worst-first ordering agree
   with `summarizeHierarchy(...)` on the same tree; `summarizeHierarchy`'s output shape is unchanged
   (existing tests stay green).
3. **Vanish exclusion:** vanished subtrees are absent from `paragraphs` and consistent in `counts`.
4. **Coverage:** stored spec → 200 with all scored paragraphs worst-first; unknown id → 404; a spec
   with no provenance → empty `paragraphs` + `unscoredReason`.
5. **Contract parity:** route↔openapi↔MCP-tool green (contract + MCP-contract integration tests).

## Out of scope (YAGNI / deferred)

- Raw `signal_provenance` / per-signal dump (chose "Rich", not "Rich + raw").
- Project-wide / multi-spec roll-up (single spec only).
- Any write/reclassify action from the report (read-only view).
- The WS3 gold-corpus gate itself (this report is the human-facing precursor).

## File map

| File | Change |
|------|--------|
| `src/lib/hierarchy-report.ts` | **new** — `buildHierarchyReport`, `walkScored`, shapes |
| `src/lib/hierarchy-summary.ts` | **unchanged** — kept independent; consistency pinned by a counts-equivalence test |
| `src/ast/schemas.ts` | **none** — report GETs here use TS interfaces + `openapi.yaml`, not a runtime Zod response schema |
| `src/api/specs.ts` (or a report handler file) | `getHierarchyReportHandler` |
| `src/api/router.ts` | register `GET /specs/:id/hierarchy-report` |
| `openapi.yaml` | path + schemas |
| `src/mcp/contract-map.ts` | map REST op → `get_hierarchy_report` |
| `src/mcp/capabilities.ts` | declare `get_hierarchy_report` read tier |
| `src/mcp/*handlers*` | tool handler |
| `examples/web_ui_demo/js/scoring.js` | **new** — two-pane view |
| `examples/web_ui_demo/js/api.js` | `getHierarchyReport(specId)` |
| `examples/web_ui_demo/index.html` + nav | "Scoring" tab wiring |
