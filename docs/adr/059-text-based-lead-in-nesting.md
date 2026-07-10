# ADR-059: Text-based lead-in nesting for mixed-scheme sub-lists

**Status:** Accepted

## Context

A recurring hand-authored pattern breaks the 5-signal inference engine: an
article contains a **lead-in** paragraph ("Abbreviations and Acronyms:",
"Definitions:") that introduces a manually typed sub-list ("1. …", "2. …"). The
lead-in carries no typed marker of its own — its tier comes from Word numbering,
a style, or its indentation — while the sub-list items carry typed "1./2./…"
markers matched by Signal 4.

When the lead-in and the sub-list **resolve to the same tier** (both pr2 in the
`more-parsing-examples-fails.docx` REFERENCES article), `buildTree` lands the
sub-list as **siblings** of the lead-in rather than its children. The
`stripOutlineLabels` post-pass then computes each item's label from its sibling
position (`2.`, `3.`, …) which does not equal the author's typed `1.`, `2.`, so
the typed marker is left in place and the renderer emits a double label:

```
2. 1. Authority having jurisdiction (AHJ)
```

The defect exists **only** at that same-tier collision. If the sub-list were
already one tier deeper, `buildTree` nests it correctly and there is nothing to
fix. This is a genuinely ambiguous OOXML case (per CLAUDE.md's OOXML ambiguity
rule) — the author's intent (sub-list nested under the lead-in) is not encoded in
any single signal; it is only recoverable from the *sequence* (a numbered lead-in
immediately followed by a typed restart run at the same tier).

## Decision

Add a pure **post-classification sequence pass**, `nestLeadInSublists`
(`src/parser/docx/lead-in-nesting.ts`), wired `classifyParagraphs →
nestLeadInSublists → buildTree` in the DOCX pipeline. It **promotes** a
qualifying lead-in up one tier; the sub-list stays put, so `buildTree` nests it
and the existing label-strip removes the now-matching markers. The pass is pure —
it returns a new array, reuses unchanged element references, and never mutates the
input — and computes every decision against the **original** array so an earlier
promotion cannot mis-parent a later lead-in.

### Trigger (same-tier collision) — all must hold, on the original array

1. Candidate **X** has **no typed label of its own** and is structural at pr1 or
   deeper (`signalUsed !== 4`, `nodeType !== 'continuation'`, `resolvedIlvl ≥ 2`).
2. The **immediately following** item is a Signal-4 item at the **same resolved
   tier T** as X.
3. That run **restarts**: its first typed marker is ordinal 1 (`leadingMarkerOrdinal === 1`).
4. **Colon modulator** (below) is satisfied by the run length.
5. **Promotion room:** X's structural parent (nearest preceding non-continuation
   with tier < T) sits at tier `< T − 1`. No room → skip (KNOWN AMBIGUITY).

### Promote, not demote

Promoting the lead-in (pr2 → pr1) keeps the sub-list at its typed tier, so the
computed labels (`1.`, `2.`) **match and strip** the typed markers, yielding clean
CSI. Demoting the sub-list instead would nest it but push it into the next
scheme (pr3 `a.`), leaving the typed `1.` unstripped → `a. 1. Authority`. Promotion
is only clean because a candidate lead-in has no typed label of its own; a Signal-4
lead-in would double-label *itself* if promoted, which is why it is excluded.

### Colon as a modulator, not a gate

If X's text ends with `:`, a run of **≥1** restart item fires; otherwise **≥2** is
required. Keying the trigger on the same-tier collision (not the colon) is what
keeps clean documents untouched; the colon only tunes how much evidence a
colon-less lead-in ("Abbreviations and Acronyms" with no trailing colon) needs.

### Recorded conflict

The pre-promotion tier is appended to X's `conflicts` (`{ signal, reportedIlvl,
reportedNodeType }`) — conflicts are persisted, never dropped — which also lowers
X's hierarchy-confidence score, correctly reflecting that the promotion is an
inferred correction rather than a directly observed tier.

### Predicate deviation from the brainstorm spec

The approved design gated candidacy on `signalUsed ∈ {1,2}`, describing the
lead-ins as "Word-numbered (numId 9)". In reality the lead-ins classify via
**Signal 5 (indentation)**: they carry `numId=9` at `ilvl=0`, where
`ilvlToNodeType(0, …)` returns `'part'`, so Signal 1's PART-heading guard bails
(not a PART heading, `numId 9` not spec-shaped) and Signal 2 finds no numbering
for the `ListParagraph` style — the paragraph falls through to Signal 5. Under the
literal `{1,2}` predicate the pass would never fire and the design's own
acceptance test would be impossible. We therefore broadened the predicate to the
design's stated **rationale** — "has no typed label of its own" — i.e.
`signalUsed !== 4` (Signal 1, 2, or 5). This matches intent exactly; a Signal-4
candidate is still excluded because it *does* carry a typed label.

## Consequences

- **Fixes** the mixed-scheme double-label: `1.2 REFERENCES` now renders
  `A. Abbreviations {1..5}`, `B. Definitions {1,2}` with markers stripped.
- **Surgical.** Keying on the same-tier collision leaves clean documents (no
  collision) untouched. Corpus A/B (`pnpm fixture:snapshot`/`fixture:diff`):
  **0 structural regressions**; only the target fixture changes.
- **Out of scope (pinned as KNOWN AMBIGUITY tests):** the messier
  `References Standards:` subtree (a stray `1 Cable:` parsed as a continuation,
  pr4 depth) whose following run is not a Signal-4 restart is not promoted; once
  Definitions is promoted it nests under Definitions rather than remaining a
  REFERENCES-level peer. The no-promotion-room case is likewise left as-is. A
  correct fix for those tangles is a separate slice.
- **Confidence.** Promoted lead-ins carry a low confidence (base Signal-5 tier
  minus the recorded conflict), surfacing the inferred correction to reviewers.
