# ADR-074: Highlight is a first-class editor clue

## Status: Accepted

Builds on ADR-021 (open style/source storage) and ADR-022 (persistent source facts
and pure, profile-driven editability classification).

## Context

Yellow text highlight commonly marks a decision that a specification editor must
resolve before Final issuance. It is acceptable in a Draft but needs direct review
later. SpecR already preserved direct `w:highlight` as a synthetic run-color token
(`highlight:<color>`), but that compatibility representation omitted the run text
and did not give highlight its own convention or review semantics.

Highlight is not ordinary font color. A paragraph can carry both, and a small
highlighted choice remains actionable even when it covers little of the paragraph.
Existing persisted masters contain only the synthetic token and cannot be reparsed
after the source DOCX bytes have been discarded.

## Decision

1. Capture each directly highlighted run as `sourceFacts.highlights[]` with its
   named OOXML color, exact run text, and half-open paragraph-relative span. The
   open fact schema preserves unknown JSON properties.
2. Continue emitting the existing `colors[]` token `highlight:<color>` unchanged.
   When first-class facts are absent, a shared adapter reconstructs highlight facts
   from those stored color spans and paragraph text. When first-class facts exist,
   the adapter ignores compatibility tokens so a clue is never counted twice.
3. Add profile data `highlightMeanings[]`. Classification precedence is:
   fixed body object → note banner → comment → explicit choice token → highlight
   → font color → default. The first mapped highlighted run in document order wins
   with confidence `0.85`, like an explicit choice-token clue. Lookup is
   case-insensitive; evidence retains the captured color and real fact path.
4. A reversible migration adds `yellow → choice` only to the read-only built-in
   profile. Existing library profiles are not silently rewritten; firms can add,
   change, or omit mappings through the existing convention API.
5. Onboarding and editability review surface every highlighted paragraph with its
   outline path and run facts. This is advisory input for the companion issuance-
   readiness gate; this change does not block Final issuance.

## Consequences

- New and previously persisted masters reclassify consistently without the source
  DOCX, preserving ADR-022's permanent-facts guarantee.
- Highlight beats incidental font color deterministically, while stronger note,
  comment, and explicit token clues retain their established precedence.
- Direct `w:highlight` is covered; shading (`w:shd`) and style-inherited highlight
  remain separate future decisions. Bold, italic, and underline are unchanged.
