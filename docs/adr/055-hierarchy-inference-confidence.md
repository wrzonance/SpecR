# ADR-055: Hierarchy-inference confidence — provenance jsonb + read-time scorer

## Status

Accepted (2026-07-07). Implements the approved design in
`docs/superpowers/specs/2026-07-07-hierarchy-confidence-design.md`.
(The design doc reserved "ADR-054"; 054 was taken by first-class-clients.)

## Context

The 5-signal DOCX inference engine records *disagreement* (`paragraphs.conflicts`
→ `meta.conflicts`) but not how strongly the winner was supported: a paragraph
classified by the indentation fallback alone looked identical to one nailed by
numbering.xml with full corroboration — both had empty conflicts. Editability
classification and style consensus already expose 0–1 confidence in the API
contract; hierarchy inference did not, so human review triage (onboarding
report, future review canvas #143) had nothing to rank by. The blind spot of
unanimous-but-weak wins is the point: disagreement alone is not enough.

## Decision

1. **Persist facts, derive the score at read time.** New nullable
   `paragraphs.signal_provenance` jsonb (migration 041):
   `{ signalUsed: 1–5, agreed: (1–5)[] }`. A signal is `agreed` when its vote
   matches the FINAL resolved (nodeType, normalizedIlvl) — post-
   `correctMisalignedArticle`. `scoreHierarchyConfidence`
   (`src/parser/docx/hierarchy-confidence.ts`) derives
   `{ confidence, signalUsed, agreed, evidence }` from provenance + conflicts at
   every read (render-derived house style) — formula v1's constants (base =
   signal reliability tier 0.95/0.85/0.6/0.6/0.35, corroboration weight 0.15,
   conflict penalty 0.1 + 0.02·ilvl-distance, clamp [0,1], review threshold 0.6)
   are acknowledged heuristics, tunable without migration or reparse.
2. **Unscored honesty.** NULL provenance (pre-provenance parse, non-DOCX source,
   manually inserted paragraph, non-structural node) never yields a number
   anywhere; the report's `unscored` bucket carries its reason, and an
   explicit-structure source (`ufgs`/SEC) reads as by-design, never suspect.
3. **Signal-derived, never vendor-keyed** (standing rule): scoring inputs and
   evidence strings name signals ("indentation won alone", "style chain
   disagreed: pr1 vs article"), never vendors.
4. **Surfaces in contract lockstep:** `meta.inference` on every paragraph read
   (`GET /specs/{id}`, paragraph write responses, MCP `get_paragraph`) and a
   `hierarchy` section in the onboarding report (REST job + MCP
   `get_onboarding_report`), mirrored on the editability summary pattern
   (`src/lib/hierarchy-summary.ts`). `conflicts` remains untouched — persisted,
   never dropped.
5. **db → parser (barrel-only) import accepted.** The read mappers derive
   `meta.inference` via `deriveInference` (`src/db/queries/inference-meta.ts`),
   which validates the raw jsonb (Zod, fail-loud) and calls the parser's pure
   scorer. Acyclic; precedent: `db/queries/reclassify.ts` already imports the
   conventions engine.

## Consequences

- Reparse/re-import is the upgrade path for pre-provenance rows (reclassify
  touches only the `classification` column); the report says so.
- A numbering-profile demotion (#317/#319) lands in `conflicts`, so the score
  drops naturally; profile-`tier` authority as a scoring input is deferred
  (#319 territory).
- Deferred (spec "out of scope"): spec-level aggregate rollup on spec reads,
  threshold configurability (env/profile), import-time quality gating.
- Zero classification drift proven by fixture A/B (`pnpm fixture:snapshot/diff`)
  over the local corpus: byte-identical renders before/after.
