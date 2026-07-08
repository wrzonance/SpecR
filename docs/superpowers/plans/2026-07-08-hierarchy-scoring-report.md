# Per-paragraph hierarchy-scoring report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a stored spec's per-paragraph hierarchy-inference confidence retrievable (REST + MCP) and browsable (demo "Scoring" tab) — the "report before the gate" (WS2, issue #424).

**Architecture:** A shared, tested scoring module (`src/lib/hierarchy-report.ts`) reads what `getSpecTree` already derives (`meta.inference`, ADR-055), producing a full worst-first per-paragraph report. A dedicated REST endpoint and a contract-bound MCP tool expose it; a two-pane demo view (mirroring `js/audit.js`) renders it. No change to the inference engine, parser, worker, or DB.

**Tech Stack:** TypeScript/Node 22, Express, Zod v4, pnpm, vitest. Demo: vanilla ES modules + `.test.mjs`.

**Design doc:** `docs/superpowers/specs/2026-07-08-hierarchy-scoring-report-design.md`.

## Global Constraints

Every task's requirements implicitly include these (from `CLAUDE.md` + `~/.claude/rules`):

- **ESLint enforced:** `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` 50, `max-lines` 400/file, `no-console` (use `src/lib/logger.ts`), `@typescript-eslint/no-explicit-any` error.
- **TS strict+:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (⇒ `import type` for type-only imports), no `any`, no `as unknown as`, no non-null `!` outside tests. ESM: relative imports end in `.js`.
- **Labels:** never reimplement CSI numbering — import `getLabel`/`consumesNumber` from `../ast/index.js`.
- **openapi.yaml is authoritative** — any route/response change updates it in the same PR (contract gate).
- **MCP tools never throw** — return `{ isError: true, content: [...] }`; import DB functions from `../db/index.js` only; use `z.uuid()` (Zod v4).
- **Errors:** boundary-typed, no internals/stack leak. Handlers return `ApiResponse<T>` `{ success, data|error }`.
- **Commits:** Conventional Commits, scope = module changed; branch `feat/hierarchy-scoring-report`; PR is a **draft**; `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Single PR for all four tasks.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/hierarchy-report.ts` | **new** — `ScoredParagraph`, `HierarchyReport`, `buildHierarchyReport`. Owns the label-aware scored walk. |
| `src/lib/hierarchy-report.test.ts` | **new** — unit tests incl. label-non-drift + counts-equivalence. |
| `src/ast/schemas.ts` | add `ScoredParagraphSchema` + `HierarchyReportSchema` (boundary validation + openapi mirror). |
| `src/api/specs.ts` | add `getHierarchyReportHandler`. |
| `src/api/specs.test.ts` | handler unit tests (200/400/404). |
| `src/api/router.ts` | register `GET /specs/:id/hierarchy-report`. |
| `openapi.yaml` | path + `HierarchyReport`/`ScoredParagraph` schemas. |
| `src/mcp/contract-map.ts` | map the route → `get_hierarchy_report`. |
| `src/mcp/capabilities.ts` | declare `get_hierarchy_report` `read` tier. |
| `src/mcp/*` tool registry + handler | register + implement the tool (mirror `coordination_report`). |
| `examples/web_ui_demo/js/api.js` | `getHierarchyReport(specId)`. |
| `examples/web_ui_demo/js/scoring.js` | **new** — two-pane view. |
| `examples/web_ui_demo/index.html` + nav wiring | "Scoring" tab. |
| `examples/web_ui_demo/scoring.test.mjs` | **new** — report-model shaping + filter behavior. |

## Design note — DRY without the knot (refinement of the spec)

The spec proposed refactoring `summarizeHierarchy` to consume one shared walk. Tracing the code shows the report's walk must be **ordinal-aware** (mirror `renderMarkdown` for labels), while `summarizeHierarchy`'s is a flat tally-recurse — merging them needs branches that serve neither cleanly (the anti-pattern in `code.md`'s DRY rule), and it perturbs a shipped contract (onboarding report + `get_onboarding_report`). **Decision:** leave `summarizeHierarchy` untouched; build `buildHierarchyReport` independently; pin consistency with a **counts-equivalence invariant test**. External contract unchanged.

---

### Task 1: Scoring module — `src/lib/hierarchy-report.ts`

The whole backend value; everything else is wiring. Produces the report from a `SpecTree`, computing labels via the canonical primitives.

**Files:**
- Create: `src/lib/hierarchy-report.ts`
- Create: `src/lib/hierarchy-report.test.ts`

**Interfaces:**
- Consumes: `getLabel`, `consumesNumber`, `nodeTypeToNormalizedIlvl` and types `NodeType`, `SignalNumber`, `SignalConflict`, `SpecNode`, `SpecTree` from `../ast/index.js`; `HIERARCHY_REVIEW_THRESHOLD` from `./hierarchy-summary.js`.
- Produces:
  ```typescript
  export interface ScoredParagraph {
    readonly nodeId: string;
    readonly nodeType: NodeType;
    readonly ilvl: number;
    readonly label: string;              // canonical getLabel, e.g. "1.2.A"
    readonly preview: string;            // node text trimmed to PREVIEW_MAX
    readonly confidence: number;
    readonly signalUsed: SignalNumber;
    readonly agreed: readonly SignalNumber[];
    readonly evidence: readonly string[];
    readonly conflicts?: readonly SignalConflict[];   // omitted when none
  }
  export interface HierarchyReport {
    readonly counts: { readonly scored: number; readonly unscored: number; readonly belowThreshold: number };
    readonly unscoredReason?: string;
    readonly paragraphs: readonly ScoredParagraph[];    // ALL scored, worst-first
  }
  export function buildHierarchyReport(
    tree: SpecTree, source: string | null, threshold?: number,
  ): HierarchyReport;
  ```

**Label walk (mirror `renderMarkdown` exactly — `src/generator/markdown.ts`):** advance the CSI ordinal only past `consumesNumber` siblings; part label `getLabel('part', partIndex)`; article `getLabel('article', ordinal, partIndex + 1)`; pr-tier `getLabel(node.type, ordinal)`. Prune `meta.vanish` subtrees entirely; a note/continuation/vanish node is non-structural (no label, does not advance the ordinal). Reuse `HIERARCHY_REVIEW_THRESHOLD` and the exact `unscoredReason` strings from `hierarchy-summary.ts` (import the constant; copy the two reason strings into a shared spot only if lint flags duplication — otherwise re-declare locally with a comment pointing at the source, since re-exporting internal strings widens that module's surface).

- [ ] **Step 1: Write the failing label-non-drift test**

`src/lib/hierarchy-report.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { buildHierarchyReport } from './hierarchy-report.js';
import { renderMarkdown } from '../generator/index.js';
import type { SpecTree } from '../ast/index.js';

// A small tree with a scored Part → Article → Paragraph, an interleaved note
// (must not shift ordinals), and a second article. Inference present on the
// structural nodes so they are "scored".
function scoredTree(): SpecTree {
  const inf = (confidence: number) => ({
    confidence, signalUsed: 4 as const, agreed: [1 as const], evidence: ['e'],
  });
  return {
    section: '09 91 23', title: 'T',
    parts: [
      { id: 'p1', type: 'part', text: 'GENERAL', children: [
        { id: 'n1', type: 'note', text: 'editorial', children: [], meta: {} },
        { id: 'a1', type: 'article', text: 'SUMMARY', children: [
          { id: 'x1', type: 'paragraph', text: 'Provide unit prices', children: [], meta: { inference: inf(0.28) } },
        ], meta: { inference: inf(0.9) } },
        { id: 'a2', type: 'article', text: 'REFERENCES', children: [], meta: { inference: inf(0.55) } },
      ], meta: { inference: inf(0.95) } },
    ],
  } as unknown as SpecTree; // shape-only fixture; cast is test-local (allowed)
}

describe('buildHierarchyReport — labels', () => {
  it('every ScoredParagraph.label matches the label renderMarkdown emits for that node', () => {
    const tree = scoredTree();
    const report = buildHierarchyReport(tree, 'arcat');
    const md = renderMarkdown(tree);
    for (const p of report.paragraphs) {
      // The rendered markdown must contain "<label> <text>" for each scored node.
      expect(md).toContain(`${p.label} ${p.preview}`);
    }
    // The interleaved note did not shift the article ordinals.
    const summary = report.paragraphs.find((p) => p.nodeId === 'a1');
    expect(summary?.label).toBe('1.1');
  });
});
```

- [ ] **Step 2: Run it — verify it fails** (`pnpm exec vitest run src/lib/hierarchy-report.test.ts`) — FAIL: module not found.

- [ ] **Step 3: Implement `hierarchy-report.ts`** — shapes above + a `walkScored` mirroring `renderMarkdown`'s traversal, emitting an entry per scored structural node and tallying `scored`/`unscored`; `buildHierarchyReport` sorts entries by `confidence` asc (tie-break `nodeId.localeCompare`), computes `belowThreshold` (`confidence < threshold`), and attaches `unscoredReason` when `unscored > 0` (UFGS source ⇒ explicit-structure reason, else pre-provenance reason — same text as `hierarchy-summary.ts`). Keep each function ≤ 50 lines / complexity ≤ 10 (split the part/article/pr recursion into small helpers as `markdown.ts` does).

- [ ] **Step 4: Run the label test — PASS.**

- [ ] **Step 5: Write the remaining behavior tests** (same file): (a) **all-scored, worst-first** — `paragraphs.map(p=>p.confidence)` is ascending and length == count of scored nodes; (b) **counts-equivalence** — `buildHierarchyReport(tree,src).counts` deep-equals `summarizeHierarchy(tree,src).counts`, and the `< threshold` subset of `paragraphs` matches `summarizeHierarchy(...).lowConfidence` on nodeId/confidence; (c) **vanish-exclusion** — a `meta.vanish` article and its children appear in no entry and are not counted; (d) **unscored/empty** — a tree whose structural nodes have no `inference` yields `paragraphs: []`, `counts.scored: 0`, and a populated `unscoredReason` (UFGS vs pre-provenance by `source`); (e) **preview truncation** — text longer than `PREVIEW_MAX` is trimmed and the entry still labels correctly; (f) **conflicts** — a node with `meta.conflicts` surfaces them; without, the field is absent (`exactOptionalPropertyTypes`).

- [ ] **Step 6: Run all tests — PASS. Lint + build** (`pnpm lint && pnpm build`).

- [ ] **Step 7: Commit** — `feat(lib): buildHierarchyReport — per-paragraph inference scoring (worst-first)`.

---

### Task 2: Zod schema + REST endpoint + openapi

**Files:**
- Modify: `src/ast/schemas.ts` (add `ScoredParagraphSchema`, `HierarchyReportSchema`)
- Modify: `src/api/specs.ts` (add `getHierarchyReportHandler`), `src/api/specs.test.ts`
- Modify: `src/api/router.ts` (register route)
- Modify: `openapi.yaml`

**Interfaces:**
- Consumes: `buildHierarchyReport` (Task 1); `getSpecTree`, `getSpecSource` from `../db/index.js` (add `getSpecSource` to the barrel if not already exported).
- Produces: `getHierarchyReportHandler(req, res): Promise<void>`; route `GET /specs/:id/hierarchy-report`.

**Handler pattern — mirror `getSpecLineageHandler` (`src/api/specs.ts:55`):** validate `req.params['id']` with `z.uuid()` (invalid → 400 `invalid spec id`); `getSpecTree(id)` → falsy → 404 `spec not found`; `getSpecSource(id)` for the source; `buildHierarchyReport(result.tree, source)`; 200 `{ success: true, data: report }`; catch → `logger.error` + 500 `internal server error`.

- [ ] **Step 1: Write the failing handler tests** (`src/api/specs.test.ts`, mirror the existing `getSpecLineageHandler` describe block): invalid id → 400; unknown id (`getSpecTree` resolves null) → 404; valid stored spec → 200 with `data.paragraphs` worst-first and `data.counts`. Mock `getSpecTree`/`getSpecSource`/`buildHierarchyReport` via `vi.mock` as the sibling tests do.
- [ ] **Step 2: Run — FAIL** (handler undefined).
- [ ] **Step 3: Implement the handler + register the route** in `router.ts` next to `router.get('/specs/:id/lineage', …)`.
- [ ] **Step 4: Run handler tests — PASS.**
- [ ] **Step 5: Add Zod schemas** in `src/ast/schemas.ts` mirroring existing report schemas; export for reuse. (These validate the shape and are the openapi mirror source of truth.)
- [ ] **Step 6: Update `openapi.yaml`** — add `GET /specs/{id}/hierarchy-report` (200 → `HierarchyReport`, 400, 404) and `HierarchyReport` + `ScoredParagraph` component schemas matching the Zod shapes.
- [ ] **Step 7: Run the contract gate + full unit suite + lint + build** (`pnpm test && pnpm lint && pnpm build`; the contract integration test runs in CI — note if DB-gated locally). Contract gate must be green (route documented; response matches schema).
- [ ] **Step 8: Commit** — `feat(api): GET /specs/:id/hierarchy-report + openapi`.

---

### Task 3: MCP tool `get_hierarchy_report`

Report-style GET → 1:1 read tool. **Exact template: `coordination_report`** (REST handler + MCP tool + contract wiring + tier + test — the established report template).

**Files:**
- Modify: `src/mcp/contract-map.ts` (route → tool mapping so INV-1/2/3 pass — this route is a normal mapped op, **not** `MCP_UNEXPOSED`/`MCP_NATIVE`)
- Modify: `src/mcp/capabilities.ts` (`['get_hierarchy_report', 'read']` in `TOOL_TIERS`)
- Modify: the MCP tool registry + add the tool handler file (mirror `coordination_report`'s)
- Test: MCP handler unit test + the MCP contract integration test (INV-1/2/3) stays green

**Interfaces:**
- Consumes: `buildHierarchyReport`, `getSpecTree`, `getSpecSource` from `../db/index.js`.
- Tool input: `{ specId: z.uuid() }`. Output: `HierarchyReport` as tool content. Never throws → `{ isError: true }` on failure/not-found.

- [ ] **Step 1: Write the failing MCP handler test** (mirror the `coordination_report` handler test): known specId → report content; unknown specId → `{ isError: true }` (no throw); invalid specId → `{ isError: true }`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement the tool handler** (mirror `coordination_report`); register it; add the tier to `capabilities.ts`; wire `contract-map.ts` so the new route maps to the tool.
- [ ] **Step 4: Run the MCP handler test — PASS.**
- [ ] **Step 5: Run the MCP contract integration test** (INV-1/2/3) — green (route↔tool parity). Run in CI if DB-gated.
- [ ] **Step 6: Lint + build; Commit** — `feat(mcp): get_hierarchy_report tool (read tier, contract-bound)`.

---

### Task 4: Demo "Scoring" tab

**Exact template: `examples/web_ui_demo/js/audit.js`** (two-pane Report tab: list left, spec right, click-to-jump via `expandAncestors` + hover-walker).

**Files:**
- Modify: `examples/web_ui_demo/js/api.js` (add `getHierarchyReport(specId)` mirroring `getSpecTree`)
- Create: `examples/web_ui_demo/js/scoring.js`
- Modify: `examples/web_ui_demo/index.html` (nav/tab entry + container) and wherever tabs are registered
- Create: `examples/web_ui_demo/scoring.test.mjs`

**Behavior:** on tab open with a selected spec, fetch `getHierarchyReport(specId)` and `getSpecTree(specId)`. Left pane: worst-first rows (confidence badge color-banded, `label`, truncated `preview`, `signalUsed`/`agreed` line) + a filter control (`all` · `<50%` · `<60%` · `document-order`). `<60%` filters `confidence < 0.6`; `document-order` re-sorts by the paragraphs' natural tree position (derive from the fetched tree). Right pane: the spec render; clicking a row calls `expandAncestors` (tree.js) then scrolls/highlights `[data-node-id="<nodeId>"]`, exactly as `audit.js` drives finding→paragraph. Header shows `counts`; when `unscored > 0`, show `unscoredReason` (so UFGS/pre-provenance reads as "unscored by design").

- [ ] **Step 1: Write failing `scoring.test.mjs`** — a pure report-model helper (extract from `scoring.js`): given a `HierarchyReport` + filter, returns the rows to render. Assert: `all` returns all worst-first; `<50%`/`<60%` filter by band; `document-order` reorders by supplied position map. (Mirror `compare-filter.test.mjs`'s style — model-level, no DOM.)
- [ ] **Step 2: Run — FAIL** (`node --test examples/web_ui_demo/scoring.test.mjs` or the demo's runner).
- [ ] **Step 3: Implement `scoring.js`** (model helper + view), `getHierarchyReport` in `api.js`, and the tab wiring in `index.html`.
- [ ] **Step 4: Run `scoring.test.mjs` — PASS.**
- [ ] **Step 5: Manual smoke** — start the demo, open Scoring for a DOCX spec, confirm worst-first list, filters, and click-to-jump highlight; open a UFGS spec, confirm the `unscoredReason` header.
- [ ] **Step 6: Commit** — `feat(example): Scoring tab — per-paragraph confidence triage`.

---

## Self-Review (author checklist — done)

- **Spec coverage:** module (T1) · REST+openapi (T2) · MCP (T3) · demo (T4) — all four design components mapped; out-of-scope items excluded.
- **Placeholders:** none — new logic (label walk, shapes, handler, tool) is concretely specified; wiring points at exact templates (`getSpecLineageHandler`, `coordination_report`, `audit.js`) with file refs.
- **Type consistency:** `ScoredParagraph`/`HierarchyReport`/`buildHierarchyReport` signatures identical across T1–T3; `get_hierarchy_report` and `GET /specs/:id/hierarchy-report` named consistently throughout.
- **Green between steps:** T1 is self-contained; T2 adds the endpoint; T3 adds MCP (contract gate green); T4 is demo-only. `summarizeHierarchy` never changes.
