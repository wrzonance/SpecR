# #431 Text-Based Lead-In Nesting Implementation Plan

> **For agentic workers:** Inline TDD execution (single implementer). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Promote a no-typed-label numbered/indented lead-in one tier when it collides at the same resolved tier with an immediately-following Signal-4 restart sub-list, so the sub-list nests as children and its typed labels strip clean.

**Architecture:** A pure post-classification sequence pass `nestLeadInSublists(classified)` in a new file `src/parser/docx/lead-in-nesting.ts`, wired `classifyParagraphs → nestLeadInSublists → buildTree` in `src/parser/docx/index.ts` (runPipeline). A pure helper `leadingMarkerOrdinal(text)` added to `heuristics.ts`.

**Tech Stack:** TypeScript (strict + noUncheckedIndexedAccess + verbatimModuleSyntax), vitest, ESM (`.js` imports).

## Global Constraints (verbatim from CLAUDE.md)

- ESLint: complexity ≤10, sonarjs/cognitive-complexity ≤10, max-lines-per-function ≤50, max-lines ≤400/file, no-console (use logger), no explicit `any`, no `as unknown as`, no non-null `!` outside tests.
- Immutability: never mutate the input array; return new objects for promoted entries.
- Conventional commits, scope = `parser`. Co-Authored-By trailer required.
- **Corpus A/B gate: 0 structural regressions across the local fixture corpus.**
- **DEVIATION FROM DESIGN (flagged to lead):** Trigger #1 broadened from `signalUsed ∈ {1,2}` to "not Signal-4" (`signalUsed ∈ {1,2,5}`), because the real lead-ins classify via Signal 5 (indentation), not 1/2 — the design's own acceptance test requires this. Honors the design's stated rationale ("has no typed label of its own"). Documented in ADR-059.

---

### Task 1: `leadingMarkerOrdinal` helper

**Files:**
- Modify: `src/parser/docx/heuristics.ts`
- Test: `src/parser/docx/heuristics.test.ts`

**Interfaces:**
- Produces: `export function leadingMarkerOrdinal(text: string): number | null` — the 1-based ordinal of the leading list marker within its own scheme (`"1.\tx" → 1`, `"A. x" → 1`, `"b) x" → 2`, `"10. x" → 10`), or `null` when the text does not open with a single-token pr-marker (`"1.1 x"`, `"Abbreviations:"` → null). Requires whitespace after the marker (so `"2.1 GHz"` is not a marker).

- [ ] **Step 1:** Write failing tests in heuristics.test.ts (ordinals for `1.`/`A.`/`a.`/`b.`/`10.`/paren forms; null for `1.1`, plain prose, empty).
- [ ] **Step 2:** Run → FAIL (not exported).
- [ ] **Step 3:** Implement (single regex `^(?:(\d+)|([A-Za-z]))[.)](?=\s)` on trimStart; decimal → parseInt, alpha → lower charCode−96; no `!`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(parser): add leadingMarkerOrdinal helper`.

### Task 2: `nestLeadInSublists` pass

**Files:**
- Create: `src/parser/docx/lead-in-nesting.ts`
- Test: `src/parser/docx/lead-in-nesting.test.ts`

**Interfaces:**
- Consumes: `leadingMarkerOrdinal` (Task 1); `ClassifiedParagraph` (types.ts); `NODE_TYPES_BY_NORMALIZED_ILVL` (ast).
- Produces: `export function nestLeadInSublists(classified: readonly ClassifiedParagraph[]): ClassifiedParagraph[]` — pure; promotes qualifying lead-ins (resolvedIlvl−1, matching nodeType, appended original-tier SignalConflict), else returns the same element reference.

Trigger (all hold), computed on the ORIGINAL array:
1. Candidate X: `nodeType !== 'continuation'` AND `signalUsed !== 4` AND `resolvedIlvl >= 2` (pr1+; never promote article→part).
2. `classified[i+1]` is `signalUsed === 4` AND `resolvedIlvl === T` (run starts immediately at same tier).
3. `leadingMarkerOrdinal(firstRunItem.paragraph.text) === 1` (restart).
4. Colon modulator: run length ≥ 1 if X.text trimEnd ends `:`, else ≥ 2.
5. Promotion room: nearest preceding non-continuation with `resolvedIlvl < T` has tier `< T−1`.

- [ ] **Step 1:** Write failing unit tests (invariants 1–6) with synthetic `ClassifiedParagraph[]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement pass + private helpers (`isLeadInCandidate`, `restartRunLength`, `structuralParentTier`, `shouldPromote`, `promote`).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(parser): add nestLeadInSublists post-classification pass`.

### Task 3: Wire into pipeline

**Files:**
- Modify: `src/parser/docx/index.ts` (runPipeline: `buildTree(nestLeadInSublists(classified), …)`).

- [ ] **Step 1:** Import `nestLeadInSublists`; apply before `buildTree`.
- [ ] **Step 2:** `pnpm lint` + unit tests green.
- [ ] **Step 3:** Commit `feat(parser): wire lead-in nesting into DOCX pipeline`.

### Task 4: Integration + KNOWN AMBIGUITY + regression tests

**Files:**
- Create: `src/parser/docx/more-parsing-examples-fails.integration.test.ts` (skip-if-absent).

- [ ] Assert `1.2 REFERENCES → A. Abbreviations {1.,2.,3.,4.,5.}`, `B. Definitions {1.,2.}`.
- [ ] Regression test named for the symptom.
- [ ] `// KNOWN AMBIGUITY` test for the `References Standards:` subtree (documents post-change behavior) and the no-promotion-room synthetic case (in Task 2's file).
- [ ] Commit `test(parser): integration + ambiguity coverage for lead-in nesting`.

### Task 5: Corpus A/B gate

- [ ] `pnpm fixture:snapshot after` → `pnpm fixture:diff baseline after`.
- [ ] Confirm ONLY `more-parsing-examples-fails.docx` changed (improvement); **0 regressions elsewhere**. Tighten trigger if any regression.

### Task 6: ADR-059

**Files:**
- Create: `docs/adr/059-text-based-lead-in-nesting.md` (Status/Context/Decision/Consequences), documenting same-tier-collision trigger, promote-vs-demote, colon-as-modulator, and the Signal-5 predicate deviation.

- [ ] Commit `docs(adr): ADR-059 text-based lead-in nesting`.
