# MCP Onboarding & Editability Tools (#140) Implementation Plan

> **For agentic workers:** Implement task-by-task via TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add 5 MCP tools so AI agents can drive the onboarding loop (report, review, correct, reclassify) over `POST /mcp`, each reusing the same `db/index.js` queries the REST handlers use.

**Architecture:** New handlers live in `src/mcp/onboarding-handlers.ts` (keeps `handlers.ts` and `tools.ts` under the 400-line cap). `tools.ts` imports and registers them. Each handler is a thin adapter: validate via Zod at the tool boundary, call the shared query, return `{ content }` or `{ isError }`. No new logic — single source with REST.

**Tech Stack:** TypeScript/Node 22, `@modelcontextprotocol/sdk`, Zod v4, vitest integration tests against live Postgres.

## Global Constraints

- MCP tools NEVER throw — return `{ isError: true, content: [...] }` on failure.
- Import DB functions from `../db/index.js` ONLY (the barrel). Relative imports end in `.js`; `import type` for type-only.
- `z.uuid()` (Zod v4), never `z.string().uuid()`.
- ESLint: complexity ≤10, max-lines-per-function ≤50, max-lines ≤400 (per file). No `any`, no `!` outside tests, no `console.*` (use `src/lib/logger.ts`).
- Each new tool must call the SAME db/index.js query function the REST handler uses — do not reimplement.
- No `openapi.yaml` change (MCP tools are not in the REST contract). No REST endpoint touched.

---

## Design decisions (locked)

### `get_onboarding_report` spec→report mapping

The REST report (`GET /libraries/import/jobs/:jobId`, in-memory job store) is **job-keyed** and assembled at import time from three inputs, two of which depend on the original uploaded DOCX bytes that are **not persisted**:

- `styleDerivation` — consensus audit from `analyzeDocxStyles(buffer)` — needs the raw DOCX, gone after import. **Not reconstructable from a specId.**
- `parseWarnings` — `tree.warnings` from the live parse; the DB-stored `SpecTree` (`getSpecTree`) carries no `warnings`. **Not reconstructable from a specId.**
- `editability` — `summarizeEditability(tree)`, a pure function over the persisted tree. **Fully reconstructable.**
- `styleSourceNeeded` — true when the spec has no assigned style template; the assignment **is** persisted (`getSpecStyleSource`).

**Decision:** the spec-keyed MCP report reuses the SAME pure `summarizeEditability` builder REST uses (single source) plus the persisted style-source state, and explicitly marks the import-time-only sections as unavailable rather than fabricating them. Shape:

```jsonc
{
  "specId": "...",
  "section": "...",
  "title": "...",
  "onboardingStatus": "review" | "active",
  "styleSource": { "templateId": "...", "templateName": "..." } | null,
  "styleSourceNeeded": true,            // = styleSource === null
  "editability": { "counts": {...}, "lowConfidence": [...] },   // summarizeEditability(tree)
  "note": "styleDerivation and parseWarnings are import-time-only (raw DOCX bytes are not persisted); re-import the master to regenerate them."
}
```

`summarizeEditability` is currently exported from `src/api/onboarding-report.ts`. To honor the module-boundary rule (MCP must not reach into `src/api/`), move the pure summarizer + `LOW_CONFIDENCE_THRESHOLD` to `src/lib/editability-summary.ts` and re-export from `src/api/onboarding-report.ts` so REST keeps its import path and both layers share one implementation.

### `review_editability`

Reuses `getSpecTree(specId)` — the exact query the REST tree + MCP `get_spec` surface. Walk the tree, emit `{ nodeId, value, confidence, evidence, override? }` per classified node. A `maxConfidence` filter param (optional) returns only nodes at/below that confidence (low-confidence review queue). Evidence/confidence are byte-identical to REST because they come from the same `deriveEditability` in `getSpecTree`.

### override set/clear + reclassify

Direct adapters over `setSpecEditabilityOverride` / `clearSpecEditabilityOverride` / `reclassifySpec` (the same functions `patchEditabilityHandler` / `reclassifyHandler` call). Map `OwnershipResult`/`ReclassifyOutcome` status → `isError` text. `reclassify_spec` returns `outcome.report` (same `ReclassifyReport` shape REST returns).

---

## File Structure

- Create `src/lib/editability-summary.ts` — pure `summarizeEditability` + `LOW_CONFIDENCE_THRESHOLD` (moved from api).
- Modify `src/api/onboarding-report.ts` — re-export from the new lib module.
- Create `src/mcp/onboarding-handlers.ts` — the 5 (+1 reused) tool handlers.
- Modify `src/mcp/tools.ts` — import + register the 5 tools in `registerTools`.
- Create `src/mcp/onboarding.integration.test.ts` — JSON-RPC POST /mcp tests + the single-source parity test.
- Modify `README.md` — add an MCP tools table noting the onboarding tools.
- Modify `ARCHITECTURE.md` — extend the tools.ts file-structure comment.

---

### Task 1: Extract the pure editability summarizer to `src/lib/`

**Files:**
- Create: `src/lib/editability-summary.ts`
- Modify: `src/api/onboarding-report.ts`
- Test: covered by existing `src/api/onboarding-report.test.ts` (unchanged behavior)

- [ ] Move `summarizeEditability` + `LOW_CONFIDENCE_THRESHOLD` + the private `Acc`/`walk` into `src/lib/editability-summary.ts`.
- [ ] `src/api/onboarding-report.ts` re-exports both names from the lib module.
- [ ] Run `pnpm test` (unit) — `onboarding-report.test.ts` still green.
- [ ] Commit.

### Task 2: `review_editability` handler + test (single-source parity)

**Files:**
- Create: `src/mcp/onboarding-handlers.ts`
- Modify: `src/mcp/tools.ts`
- Test: `src/mcp/onboarding.integration.test.ts`

- [ ] Write failing integration test: classified spec → `review_editability` returns per-node `{nodeId,value,confidence,evidence}`; parity assert equals `getSpecTree`-derived editability; unknown specId → `isError`; `maxConfidence` filters.
- [ ] Implement `handleReviewEditability` over `getSpecTree`; register tool.
- [ ] Run the test — green. Commit.

### Task 3: `get_onboarding_report` handler + test

- [ ] Write failing test: known spec → report with `editability`, `styleSource`, `styleSourceNeeded`, `onboardingStatus`; unknown spec → `isError`.
- [ ] Implement `handleGetOnboardingReport`; register. Green. Commit.

### Task 4: `set_editability_override` / `clear_editability_override` + test

- [ ] Write failing tests: set override flips effective value (verify via review_editability); clear removes it; wrong-spec/unknown node → `isError`; bad uuid → `isError`.
- [ ] Implement both handlers; register. Green. Commit.

### Task 5: `reclassify_spec` + test

- [ ] Write failing tests: reclassify returns `{specId,persisted,total,changed,entries}`; `preview:true` → `persisted:false`; unknown spec → `isError`.
- [ ] Implement `handleReclassifySpec`; register. Green. Commit.

### Task 6: docs + full verification

- [ ] README MCP tools table; ARCHITECTURE tools.ts comment.
- [ ] `pnpm lint`, `pnpm test`, `pnpm migrate && pnpm seed && pnpm test:integration` all green. Commit.
