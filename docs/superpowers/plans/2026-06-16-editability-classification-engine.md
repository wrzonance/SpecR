# Editability Classification Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure function `classify(tree, rules)` mapping persisted per-paragraph source facts + a convention profile to a per-paragraph editability classification (`locked | editable | choice | note`) with confidence and rule/fact-referencing evidence.

**Architecture:** New hard-boundary `src/conventions/` module that knows only AST types (no HTTP, no DB). The engine walks the `SpecTree`, and for each `SpecNode` applies a documented precedence ladder over its `meta.sourceFacts` against `ConventionRules`. Each decision records evidence referencing the specific rule key and fact path that fired. Pure: deterministic, no I/O, re-runnable forever against persisted facts (ADR-022 D4).

**Tech Stack:** TypeScript (strict, ESM, `.js` import extensions), Zod-derived types from `src/ast`, vitest unit tests.

---

## Precedence (ADR-022 D1, issue body)

Highest wins; each rung carries evidence and a confidence reflecting signal strength:

1. **note** — banner fact present (`source_facts.banner`) OR matches a `noteBanners` regex. (`vanish` is a corroborating signal, not a trigger on its own.)
2. **comment policy** — paragraph has `comments` and `rules.comments.treatAs` is set → that editability.
3. **choice** — paragraph has `choiceTokens` whose `kind` is enabled in `rules.choiceTokens`.
4. **color meanings** — paragraph has `colors`; the highest-coverage color with a `colorMeanings` entry decides; confidence scales with coverage. A color with no matching meaning does NOT decide here.
5. **default** — `rules.defaultEditability ?? 'locked'`.

## File Structure

- Create `src/conventions/error.ts` — `ConventionError extends SpecrError`.
- Create `src/conventions/types.ts` — `Evidence`, `ParagraphClassification`, `ClassifyResult`.
- Create `src/conventions/classify.ts` — `classify(tree, rules)` + pure per-node `classifyNode`.
- Create `src/conventions/classify.test.ts` — table-driven tests.
- Create `src/conventions/index.ts` — public barrel.

---

### Task 1: Module scaffold (error + types + barrel)

- [ ] Step 1: `error.ts` — `export class ConventionError extends SpecrError {}`.
- [ ] Step 2: `types.ts` — evidence + classification result interfaces (readonly, immutable).
- [ ] Step 3: `index.ts` barrel exporting `classify`, `ConventionError`, and the result types.

### Task 2: classify — default fallthrough (RED→GREEN)

- [ ] Test: a node with no facts → `defaultEditability` (and `locked` when unset), evidence `defaultEditability`.

### Task 3: color meanings rung

- [ ] Test: full-coverage blue with `colorMeanings[0000FF]=editable` → editable, confidence high.
- [ ] Test (AC): color present but NO `colorMeanings` entry → falls through to default, evidence says default.
- [ ] Test: partial coverage → lower confidence than full coverage.

### Task 4: choice rung

- [ ] Test (AC): choice-token candidate classifies `choice` ONLY when `rules.choiceTokens` enables that kind.
- [ ] Test: token kind not enabled → falls through (to color/default).

### Task 5: comment policy rung (above choice/color)

- [ ] Test: comment present + `comments.treatAs=note` outranks an enabled choice token.

### Task 6: note rung — top precedence

- [ ] Test (AC): banner fact present AND fully blue (editable color) → classifies `note` (banner wins).
- [ ] Test: `noteBanners` regex match on node text → note.
- [ ] Test: invalid regex source in `noteBanners` → ConventionError-free (engine skips bad pattern, still pure).

### Task 7: purity + tree walk

- [ ] Test (AC): same `(tree, rules)` inputs → deep-equal outputs across two calls.
- [ ] Test: nested tree → every node (all depths) classified, order preserved.

### Task 8: lint + full test run + commit + PR
