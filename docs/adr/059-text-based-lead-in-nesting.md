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

Decisions are computed over the **non-empty content view** — the same filter
buildTree applies (`text.trim().length > 0`) — so a blank spacer paragraph between
the lead-in and its list cannot defeat the adjacency check while the assembled tree
still shows the collision.

### Primary trigger (same-tier collision) — all must hold

1. Candidate **X** has **no typed label of its own** and is structural at pr1 or
   deeper (`nodeType !== 'continuation'`, `resolvedIlvl ≥ 2`, and **Signal 4 did not
   fire at all**). Signal 4 is the only classifier that reads a marker from the
   text, so a node that WON via Signal 1/2 numbering but whose text Signal 4 also
   matched (recorded in `agreed`/`conflicts`) still carries a typed label — promoting
   it would double-label (`A. 1. Group:`), because buildTree's strip only fires on a
   Signal-4 winner. Candidacy therefore checks `signalUsed !== 4 && !agreed.has(4) &&
   !conflicts.has(4)`, not merely the winning signal.
2. The **immediately following** content item is a Signal-4 item at the **same
   resolved tier T** as X.
3. That run **restarts**: its first typed marker is ordinal 1 (`leadingMarkerOrdinal === 1`).
4. **Colon modulator** (below) is satisfied by the run length.
5. **Promotion room:** X's structural parent (nearest preceding non-continuation
   with tier < T) sits at tier `< T − 1`. No room → skip (KNOWN AMBIGUITY).

### Don't strand peer lead-ins

Promoting a primary lead-in X must not re-parent a subsequent **same-tier peer
lead-in** under it. A peer Y — a lead-in candidate ending `:` at X's tier that
follows X with no shallower node between them (so it shares X's parent) — is
promoted to T−1 as well, **even without a Signal-4 sub-list of its own**, so the
author's peer group stays a peer group (`A./B./C.`) instead of Y being vacuumed
under the last promoted sibling. Y's own sub-content stays at its tiers and nests
under Y. Room is inherited from the primary (same parent), so no separate room
check is needed. Signal-4 sub-items and continuations are never peers. This is the
narrow widening; it is held to the corpus A/B gate (below).

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

### Recomputed provenance (not preserved)

Promotion **recomputes** X's provenance so it reflects an inferred structural
correction, not a signal consensus. Every signal that fired — the winner AND every
prior `agreed` — reported the OLD tier T; after promoting to T−1 none corroborates
the node's final tier. So `agreed` is cleared to `[]` and all old-tier votes are
folded into `conflicts` (`{ signal, reportedIlvl: T, reportedNodeType: old }`) —
losing votes persisted, never dropped. `signalUsed` is kept (there is no signal id
for the pass); `scoreHierarchyConfidence` reads it only as a base reliability tier,
not as agreement with the new tier. The net: no corroboration bonus + N conflicts →
an honestly low confidence. Preserving the old `agreed` instead would hand a
promoted node a corroboration bonus for a tier it no longer occupies — overstated
confidence (Codex P2, #431).

### Predicate deviation from the brainstorm spec

The approved design gated candidacy on `signalUsed ∈ {1,2}`, describing the
lead-ins as "Word-numbered (numId 9)". In reality the lead-ins classify via
**Signal 5 (indentation)**: they carry `numId=9` at `ilvl=0`, where
`ilvlToNodeType(0, …)` returns `'part'`, so Signal 1's PART-heading guard bails
(not a PART heading, `numId 9` not spec-shaped) and Signal 2 finds no numbering
for the `ListParagraph` style — the paragraph falls through to Signal 5. Under the
literal `{1,2}` predicate the pass would never fire and the design's own
acceptance test would be impossible. We therefore broadened the predicate to the
design's stated **rationale** — "has no typed label of its own" — realized as
"**Signal 4 did not fire at all**" (see Primary trigger #1). This matches intent
exactly; a Signal-4 winner is excluded, and so is a Signal-1/2 winner whose text
Signal 4 also matched.

### Applied at the shared classification seam

The pass runs inside `buildClassification` (the seam feeding both `parse` →
buildTree AND `analyzeDocxStyles` → `deriveTemplate`), not only on the parse path.
Deriving a numbering template off the un-promoted classifications would emit pr2
rules for lead-ins the parser AST now places at pr1 — the template and the AST must
agree. The pass is idempotent, so a single application point is safe.

## Consequences

- **Fixes** the mixed-scheme double-label: `1.2 REFERENCES` now renders three peer
  lead-ins — `A. Abbreviations {1..5}`, `B. Definitions {1,2}`, `C. References
  Standards {…}` — all direct children of the article, markers stripped.
- **Surgical.** Keying on the same-tier collision leaves clean documents (no
  collision) untouched. Even with the peer widening, corpus A/B
  (`pnpm fixture:snapshot`/`fixture:diff`): **0 structural regressions across 674
  fixtures**; only the target fixture changes.
- **Out of scope (pinned as a KNOWN AMBIGUITY test, issue #436):** `References
  Standards:` placement is now correct (C., a peer of A/B), but its **subtree**
  stays tangled — an editor typo `1 Cable:` (missing period) parses as a
  continuation instead of a `1.` restart, and the intentional category breakouts
  (`Cable Sizing:` / `Splicing:` / …) land at pr4 depth. The pass promotes the peer
  lead-in without touching that internal tangle; a correct fix is deferred to #436.
  The no-promotion-room case is likewise left as-is.
- **Confidence.** Promoted lead-ins carry a low confidence (base Signal-5 tier
  minus the recorded conflict), surfacing the inferred correction to reviewers.
