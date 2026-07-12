# ADR-067: Numbering-profile `tier` is derived, never authoritative

**Status:** Accepted

## Context

A `NumberingProfile` (`src/ast/numbering-profile-schema.ts`) carries a `tier`
field on every `styleLadder[]` entry and every `numbering[].levels[]` level.
The #299 design doc states that "when a profile is present, it is
**authoritative** for the numId→tier and style→`numPr` mapping" — language
that reads as if `tier` itself drives classification.

In fact `ilvlToNodeType` (`src/parser/docx/`) has always derived the node type
from `ilvl` + `articleIlvl` alone; the `tier` field is written by the
extractor (`tierForIlvl`) for read-side convenience and was **never read on
apply**. #317 kept `ilvl` + `articleIlvl` as the classification authority and
filed the discrepancy as #319: should a client-declared `tier` become
independently authoritative (or at least be rejected when it disagrees with
`ilvl`)? Until this ADR, an edited `tier` that disagreed with its `ilvl` was a
silent no-op — pinned only by a KNOWN AMBIGUITY test in
`numbering-profile-apply.test.ts`.

Issue #319's Option 1 was to thread `tier` through classification as a second,
independent authority alongside `ilvl` + `articleIlvl`.

## Decision

`ilvl` + `articleIlvl` remain the **single classification authority**, exactly
as #317 shipped. `tier` becomes an explicitly **derived annotation**:

- Optional on write. When omitted, the server fills it with
  `tierForIlvl(ilvl, articleIlvl)` (`src/ast/numbering-profile-schema.ts`) so
  valid read-to-write round-trips (GET → POST/PATCH) never require the client
  to compute it.
- Always present and internally consistent on a successful parse — the
  `NumberingProfile` output type pins `tier: TierName` (never
  `tier?: TierName`) on every `styleLadder`/`numbering.levels` entry.
- Rejected with **422** when a client-declared `tier` disagrees with
  `tierForIlvl(ilvl, articleIlvl)`, naming the offending entry and both the
  declared and derived values (e.g. `styleLadder[styleId=ARTICLE] ilvl=1
  declares tier 'part' but derives to 'article'`) — closing the silent no-op
  #317's KNOWN AMBIGUITY test documented.
- `articleIlvl` becomes **required** as soon as `numbering` or `styleLadder`
  is non-empty, since the derivation is undecidable without it. Extracted
  profiles always carry `articleIlvl`, so this only tightens hand-authored
  partial profiles.

Threading `tier` through classification (Option 1) is **rejected**, for three
reasons:

1. **No real-world need.** No fixture or firm template has a document where
   different numbering ladders sit at different offsets — the only scenario
   a per-entry authoritative `tier` could express that the profile-global
   `articleIlvl` cannot. Confirmed with the maintainer 2026-07-11.
2. **Granularity mismatch.** `TierName` (`part | article | paragraph |
   subparagraph`) is coarser than the node types classification must
   produce (`pr1`–`pr7`); `subparagraph` alone cannot select a depth, so
   `tier` could never fully drive classification regardless of intent.
3. **Dual-authority cost for no benefit.** Two competing authorities
   (`tier` vs. `ilvl`) would require precedence rules in the classification
   core, adding complexity with no demonstrated use case to justify it.

This ADR **supersedes** the #299 design doc's phrasing that a profile is
"authoritative for the numId→tier mapping": that authority flows through
`ilvl` + `articleIlvl`, and `tier` is a label describing the result, not an
independent input. Revisit this decision only if a genuine multi-offset
template appears — one where the same profile legitimately needs two
different `ilvl`→tier mappings in force at once — at which point `tier`-as-
authority (or a second offset field) should be reconsidered.

The validation lives once, on the write schema
(`NumberingProfileSchema` in `src/ast/numbering-profile-schema.ts`), shared by
every write path — REST (`src/api/numbering-profiles.ts`) and MCP CRUD
(`src/mcp/numbering-profile-crud-handlers.ts`) — with no per-route logic. The
read schema (`NumberingProfileReadSchema`, ADR-061) is unaffected: it still
requires `tier` on every entry — rows written under this ADR are validated
consistent, while rows persisted before this validation existed may retain a
divergent `tier` — and performs no derivation, since re-deriving on every read
would mask exactly those legacy rows.

A related implementation choice, surfaced while spiking the Zod v4
`.check()`/`.transform()` chain this validation needed: the parsed
`NumberingProfile` output type keeps `tier: TierName` **required**, via an
explicit `Omit<Shape, 'tier'> & { tier: TierName }` on each nested type,
rather than the simpler option of leaving the inferred output type
`tier?: TierName` (which `tsc` would accept just as cleanly, since no current
call site dereferences `.tier` unconditionally). The explicit type was kept
because it is what this ADR's "always present and consistent on read" promise
actually means at the type level — leaving it optional would let a future
caller add an unchecked `.tier` dereference that compiles today and only
breaks against a legacy row at runtime.

## Consequences

- A write that declares a `tier` inconsistent with `ilvl` + `articleIlvl` now
  fails fast at the boundary (422 REST, `isError: true` MCP) instead of
  silently no-op'ing at apply time.
- Hand-authored partial profiles (no `articleIlvl`) that set `numbering` or
  `styleLadder` must now also set `articleIlvl`. Profiles produced by the
  extractor are unaffected — they always carry `articleIlvl`.
- Pre-existing stored rows with a divergent `tier` remain readable (read
  schema, ADR-061) and continue to classify by `ilvl` alone; they simply
  cannot be re-saved without correcting the declared `tier` or omitting it.
- `tierForIlvl` moved from `src/parser/docx/numbering-profile.ts` to
  `src/ast/numbering-profile-schema.ts` (re-exported from the parser barrel)
  so the write schema and the parser share one derivation function instead of
  duplicating the banding rule.
- Should a genuine multi-offset template ever appear, revisit both this
  decision and the `articleIlvl`-is-profile-global assumption together —
  they are the same modeling question.

## References

- #299 — original structural numbering profile design (superseded phrasing)
- #317 — kept `ilvl` + `articleIlvl` authoritative; filed this fork
- #319 — this decision
- ADR-061 — read/write schema split (the write schema this ADR tightens)
