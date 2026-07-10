# Design — #431: text-based lead-in nesting for manual sub-lists under a mixed-scheme lead-in

**Status:** Approved (brainstorm 2026-07-09)
**Issue:** #431 (follow-up to #430 / merged PR #432)
**Module:** `src/parser/docx/` (5-signal inference engine)
**ADR:** requires **ADR-059** (new, non-obvious inference decision — repo rule)

## Context

After PR #432 (tab / centered-title / pr-label fixes) merged to `main`, the structural
parse of `docs/references/MANUFACTURER_EXAMPLES/more-parsing-examples-fails.docx` is
correct at the PART / article level. What remains is a **pr-tier nesting** ambiguity where
a document mixes numbering schemes within one article.

Ground-truth current parse of `1.2 REFERENCES`:

```
<article> "REFERENCES"
  <pr2> "Abbreviations and Acronyms:"            ← Signal 5 (indent); see CORRECTION below
  <pr2> [conf:pr3] "1.  Authority having jurisdiction (AHJ)"   ← typed "1.", Signal-4=pr2, Signal-5(indent)=pr3
  <pr2> [conf:pr3] "2.  Ethylene-propylene rubber (EPR)"
  ... (3.,4.,5. — a self-contained 1–5 restart)
  <pr2> "Definitions:"                           ← Signal 5 (indent), ends ":"
  <pr2> [conf:pr3] "1.  NETA ATS: ..."           ← another restart 1–2
  <pr2> [conf:pr3] "2.  ICEA: ..."
  <pr2> "References Standards:"                   ← Signal 5 (indent), ends ":" (messier subtree — out of scope)
```

**CORRECTION (implementation, 2026-07-09):** the ground-truth above originally called
the lead-ins "Word-numbered (numId 9)". Verified against the real DOCX, they resolve
via **Signal 5 (indentation)**, not Signal 1/2: they carry `numId=9` at `ilvl=0`, where
`ilvlToNodeType(0,…)` returns `'part'`, so Signal 1's PART-heading guard bails (not a PART
heading, `numId 9` not spec-shaped) and Signal 2 finds no numbering for the `ListParagraph`
style. The candidacy invariant is therefore **"no typed outline label of its own"** =
`signalUsed !== 4` (Signal 4 is the only classifier that reads a marker from the text) —
see the corrected Trigger #1 below and ADR-059.

The author intends the typed `1./2./…` items as **children** of the `":"`-terminated
lead-in. But the lead-in resolves (via indentation) at pr2 and the manual items also map to pr2
(`^\d+\.\s` → pr2), so they land as **siblings**. The renderer then labels the manual
items by position (`2.`,`3.`…) while the typed `1.`,`2.` remain — rendering `2. 1. Authority`.

## The core insight (why this is surgical)

The defect exists **only** when a no-typed-label lead-in (numbering/style/indent) and a
manual Signal-4 restart sub-list **collide at the same resolved tier** (both pr2 here). If the sub-list
were already deeper, `buildTree` nests it correctly and there is nothing to fix. Keying
the trigger on that **same-tier collision** means clean documents (no collision) are never
touched — this is what keeps corpus regressions near zero without using the colon as a hard gate.

## Approach (decided in brainstorm)

**Promote the lead-in**, not demote the sub-list. Moving the lead-in up one tier keeps the
manual items at their typed tier (pr2), so the existing `stripOutlineLabels` post-pass
computes labels (`1.`,`2.`) that **match and strip** the typed markers — yielding clean CSI:

```
1.2 REFERENCES
  A. Abbreviations and Acronyms:
     1. Authority having jurisdiction
     2. Ethylene-propylene rubber
  B. Definitions:
     1. NETA ATS: ...
     2. ICEA: ...
```

(Demoting the sub-list instead would nest it but push it to pr3 `a.` scheme, leaving the
typed `1.` unstripped → `a. 1. Authority`. Rejected for that reason.)

## Where it lives

A new **post-classification sequence pass** — `nestLeadInSublists(classified)` — running
**between** `classifyParagraphs` and `buildTree` in `inference.ts`. It needs look-ahead
(the following run) and look-back (the lead-in's structural parent tier), which the
per-paragraph `classifyOne` cannot provide. It returns a **new** array (immutability) and
only ever *promotes* lead-in entries. It composes with the existing style-based lead-in
mechanism (`LEAD_IN_STYLE` / `resolveLeadInNumPr`) — this is the *text/structure*-based
sibling of that *style*-based one; align naming and placement.

## Trigger (all must hold)

1. Candidate **X** has **no typed outline label of its own** = `signalUsed !== 4` (Signal 4 is
   the only classifier that reads a marker from the text; Signal 1/2/5 derive the tier without
   one, so X's text is pure content). Promoting an unlabelled lead-in stays clean; a Signal-4
   lead-in would double-label itself if promoted. *(The brainstorm wrote `signalUsed ∈ {1,2}`
   assuming the lead-ins were Word-numbered; they resolve via Signal 5 — see CORRECTION above.)*
2. Immediately followed by a run of **Signal-4** items at the **same resolved tier T** as X.
3. The run **restarts**: its first item's typed marker is ordinal 1 (`1.`/`A.`/`a.`).
4. **Promotion room**: T−1 must remain strictly deeper than X's structural parent (the
   nearest preceding non-continuation item with tier < T). No room → **skip** (KNOWN AMBIGUITY).

**Colon as modulator (not a gate):** if X's text ends with `:`, allow a run of **≥1**;
otherwise require **≥2** consecutive restart items. Colon-less lead-ins ("Abbreviations and
Acronyms" without a trailing colon) are still caught — just held to slightly stronger evidence.

## Action

Promote X by one tier (`pr2 → pr1`: both `nodeType` and `normalizedIlvl`). The Signal-4 run
stays at T, so `buildTree` nests it under X and the existing `stripOutlineLabels` strips the
typed markers. Record X's **original tier as a `SignalConflict`** on X (repo rule: "conflicts
persisted, never dropped") — which also correctly lowers X's hierarchy-confidence score, since
the promotion is an inferred correction.

**Don't strand peers (impl refinement, verified against Word):** the three lead-ins under
REFERENCES are author PEERS — `A. Abbreviations`, `B. Definitions`, `C. References Standards` —
all direct children of the article. Promoting only the two with Signal-4 sub-lists would vacuum
`References Standards:` (still pr2) under `B. Definitions`. So a same-tier peer lead-in ending
`:` that follows a promoted primary (sharing its parent) is promoted too, even without a sub-list
of its own, keeping the peer group intact.

## Explicitly out of scope (pin as KNOWN AMBIGUITY, do not fix here — issue #436)

`References Standards:` PLACEMENT is now correct (C., a peer of A/B via the peer rule above); only
its **subtree** is out of scope: an editor typo `1 Cable:` (missing period) parses as a
continuation instead of a `1.` restart, and the intentional category breakouts
(`Cable Sizing:`/`Splicing:`/…) land at pr4 depth. Pin it with a `// KNOWN AMBIGUITY` test; a
correct fix for the subtree is deferred to **#436**. Keeps this a small, correct slice.

## Data shapes

- `ClassifiedParagraph` (existing, `types.ts`): promotion produces a new object with adjusted
  `resolvedIlvl` + `nodeType` and an appended `SignalConflict` recording the pre-promotion tier.
- Restart detection needs the leading marker's **ordinal**; add a small pure helper (e.g.
  `leadingMarkerOrdinal(text): number | null`) — `"1." → 1`, `"A." → 1`, `"b." → 2`, else null.

## Interfaces

```ts
// inference.ts (new)
function nestLeadInSublists(
  classified: readonly ClassifiedParagraph[]
): ClassifiedParagraph[];   // pure; promotes qualifying lead-ins, else returns equivalents

// heuristics.ts or a small helper (new, pure)
function leadingMarkerOrdinal(text: string): number | null;
```

Wire into the pipeline: `classifyParagraphs → nestLeadInSublists → buildTree`.

## Invariants (these become the tests)

1. No-typed-label lead-in (`signalUsed !== 4`) colliding at tier T with a following Signal-4
   restart run → lead-in promoted to T−1, run nests as children, typed labels strip clean.
2. No collision (sub-list already deeper) → untouched.
3. Restart marker not ordinal 1 (continuation of outer sequence) → untouched.
4. No promotion room (parent already at T−1) → untouched (KNOWN AMBIGUITY test).
5. Colon present → ≥1 child fires; colon absent → ≥2 required (1 child, no colon → untouched).
6. Promoted lead-in carries its original tier in `meta.conflicts` (never dropped).
7. **Corpus A/B (`pnpm fixture:snapshot`/`fixture:diff`, 705 fixtures): 0 structural regressions.**

## Testing

- Fixture end-to-end: parse `more-parsing-examples-fails.docx`, assert `1.2 REFERENCES` →
  `A. Abbreviations {1.,2.,3.,4.,5.}`, `B. Definitions {1.,2.}` (skip-if-absent, like the
  existing `more-broken-parsing.integration.test.ts`).
- Unit tests on `nestLeadInSublists` + `leadingMarkerOrdinal` with synthetic
  `ClassifiedParagraph[]` covering invariants 1–6.
- `// KNOWN AMBIGUITY` test for the `References Standards:` subtree + the no-room case.
- Corpus A/B gate (invariant 7) — the hard regression guard.

## Deliverables

- `nestLeadInSublists` + `leadingMarkerOrdinal` in `src/parser/docx/`.
- Pipeline wiring in `inference.ts`.
- Unit + integration + KNOWN AMBIGUITY tests.
- **ADR-059** documenting the same-tier-collision trigger, promote-vs-demote decision, and
  colon-as-modulator rule.
- Regression test named for the symptom, e.g.
  `'inference: mixed-scheme lead-in — Abbreviations pr2 owns typed 1..5 restart, not siblings'`.
