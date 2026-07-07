# Hierarchy-Inference Confidence — Design

**Date:** 2026-07-07
**Status:** Approved (brainstorm with thewrz)
**Origin:** External-agent findings review — "productize parser confidence, don't hide it."

## Problem

The 5-signal DOCX inference engine records *disagreement* (losing signal votes persist in
`paragraphs.conflicts`, surfaced as `meta.conflicts`) but nothing records how *strongly* the
winning classification was supported. A paragraph classified by the indentation fallback alone
(signal 5, lowest reliability) looks identical to one nailed by `numbering.xml` with full
corroboration: both have empty `conflicts`. There is no per-paragraph confidence and no
spec-level inference-quality summary — unlike editability classification and style consensus,
which already expose 0–1 confidence in the API contract.

## Decisions (locked during brainstorm)

1. **Primary consumer: human review triage** — the onboarding report (mirroring the
   editability `lowConfidence` section), feeding the future review canvas (#143).
2. **Winner provenance gets persisted** — disagreement alone is not enough; the blind spot of
   unanimous-but-weak wins is the point.
3. **Representation: scalar 0–1 + review threshold**, consistent with the editability pattern.
4. **V1 surface: onboarding report + paragraph meta** (REST + MCP), contract-lockstep in one PR.
5. **Approach A: provenance jsonb + read-time scorer.** Persist facts, derive the score at
   read time (render-derived house style) — the formula can improve without migration or reparse.
6. **Signal-derived, never vendor-keyed** (standing rule): scoring inputs and evidence strings
   name signals, never source vendors.

## Architecture

### Inference change (`src/parser/docx/inference.ts`, `types.ts`)

`classifyOne` already holds all signal `hits` when picking a winner. `ClassifiedParagraph`
gains:

```ts
readonly agreed: readonly (1 | 2 | 3 | 4 | 5)[];
```

**Agreement definition:** a signal is `agreed` when its vote matches the *final* resolved
`(nodeType, normalizedIlvl)` — i.e. post-`correctMisalignedArticle`. Disagreeing losers keep
flowing to `conflicts` unchanged; signals that never fired appear in neither set.

### Persistence (migration — next available number at implementation time)

New nullable column, no backfill, reversible down:

```
paragraphs.signal_provenance jsonb NULL   -- { "signalUsed": 1, "agreed": [2, 4] }
```

- `conflicts` column untouched ("conflicts persisted, never dropped").
- `NULL` = pre-provenance parse (or non-DOCX source, or non-structural node) — honestly
  unscored, never a fake number.
- Only the DOCX 5-signal path writes provenance. `.SEC`/`.txt`/PDF parsers leave it null by
  design.

### Scorer (`src/parser/docx/hierarchy-confidence.ts`, exported via parser barrel)

Pure function, derived at read time:

```ts
scoreHierarchyConfidence(provenance, conflicts)
  → { confidence: number; evidence: string[] } | null   // null in → null out
```

Formula v1 — all constants in one documented block, tunable without migration:

- **Base** = winner reliability tier from the ARCHITECTURE.md signal table:
  numbering.xml ≈ 0.95 · style chain ≈ 0.85 · document order ≈ 0.60 ·
  text pattern ≈ 0.60 · indentation ≈ 0.35.
- **+ corroboration:** bounded bonus per `agreed` signal, weighted by that signal's own tier,
  capped at 1.0.
- **− disagreement:** penalty per conflict, severity-weighted — `nodeType` mismatch costs more
  than ilvl-only distance; ilvl distance scales the penalty.
- Clamp to [0, 1].
- **Review threshold:** module constant, v1 = 0.6 (mirrors editability's machine-confidence
  threshold pattern). Below threshold → triage list.

Evidence strings name signals, never vendors: `"indentation won alone"`,
`"no corroborating signal fired"`, `"style chain disagreed: pr1 vs article"`.

Constants are acknowledged heuristics — recorded in **ADR-054** (derive-at-read from persisted
facts; signal-derived-never-vendor-keyed; unscored-honesty for null provenance).

## Surfaces (contract-lockstep, same PR)

- **Onboarding report** (`src/api/onboarding-report.ts`): new `hierarchy` section mirroring the
  editability section's shape —
  `counts: { scored, unscored, belowThreshold }` +
  `lowConfidence: [{ nodeId, nodeType, ilvl, confidence, evidence[] }]`, sorted worst-first.
  `unscored` carries its reason ("pre-provenance parse — reclassify to score"), never folded
  into another bucket.
- **Paragraph meta** (REST paragraph read + MCP `get_paragraph`): optional `meta.inference`
  object `{ confidence, signalUsed, agreed, evidence }`, sitting beside the existing
  `meta.conflicts` (unchanged). Absent when provenance is null or the node is non-structural.
- **Contracts:** `openapi.yaml` updated in the same PR (report schema + paragraph meta); the
  ADR-026 gate validates the new shapes. No new operations → ADR-044 contract map unchanged;
  MCP tools inherit the richer payloads.

## Edge cases

- **Non-structural nodes** (vanish / note / continuation): not scored — same skip-set the
  renderers use. Provenance stays null even on new parses; never in triage.
- **Non-DOCX sources:** report distinguishes "explicit structure, no inference" (by source
  format, e.g. `.SEC`) from "unscored DOCX" — a SEC-sourced spec must not read as suspect.
- **Numbering-profile overrides** (#317/#319): provenance records the *5-signal engine's*
  outcome; a profile demotion already lands in `conflicts`, so the score drops naturally and
  evidence mentions the override. Profile-`tier` authority feeding the formula is out of scope
  (noted in ADR-054).
- **Reclassify / reparse** repopulates provenance — the upgrade path for pre-provenance rows;
  the report says so.

## Invariants

1. **Zero classification drift:** adding provenance must not change any resolved tree —
   `pnpm fixture:snapshot/diff` over the fixture corpus is byte-identical before/after
   (standing rule for inference changes).
2. **Null in → null out:** an unscored row never yields a numeric confidence anywhere in the
   API surface.
3. **Score ∈ [0, 1]** for every scored paragraph, monotonic in corroboration (adding an agreed
   signal never lowers it) and antitonic in disagreement (adding a conflict never raises it).
4. **Evidence never names a vendor** — signal names only.

## Testing

- Table-driven unit tests on the pure scorer: each winner tier, corroboration caps,
  conflict-severity ordering, clamps, null→null, monotonicity invariants.
- Inference unit tests: fixtures with known signal patterns assert `agreed` sets, including
  the post-`correctMisalignedArticle` case (`// KNOWN AMBIGUITY` if one surfaces).
- Integration: parse **both ARCAT and CPI fixtures** (CPI ilvl-offset gotcha) → report
  `hierarchy` section sane; a lone-indentation fixture lands below threshold.
- Corpus: `pnpm fixture:snapshot/diff` proves invariant 1.
- Contract: ADR-026 gate covers the new response shapes automatically.

## Chunking

Target one PR near the ~500 LOC line (migration + inference + scorer + report + openapi +
tests). If it runs over, split: **PR 1** = provenance persist + scorer + paragraph meta;
**PR 2** = report `hierarchy` section. Both independently green.

## Out of scope (deliberate)

- Spec-level aggregate score on spec reads (rollup beyond the report counts) — follow-up once
  a consumer asks.
- Threshold configurability (env/profile) — module constant for v1.
- Profile-`tier` as a scoring input (#319 territory).
- Import-time quality *gating* (blocking finalize on low confidence) — triage only, no gates.
