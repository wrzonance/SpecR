# ADR-092: the captured-object text walk becomes run-vanish-aware; #633's leak was a test-scoping gap, not a parser defect

## Status

Accepted

## Context

Two reports named the SAME captured-object text walk in `body-objects.ts`
(`collectText`/`extractBlobText`, used by both `buildTableObject` and
`buildTextBoxObject` via `transformChildren`) and the SAME test file
(`hidden-text.integration.test.ts`), and this ADR was asked to answer, once,
coherently: **at what granularity does the captured-object text walk become
visibility- and role-aware?** Investigating both together surfaced that they
have DIFFERENT answers — one is a genuine parser defect, the other is not a
parser defect at all.

**#641 — a hidden text box nested inside a visible text box leaks its
interior text (genuine defect, fixed here).** `collectText` walks every
descendant of an interior paragraph looking for `w:t` nodes, with no depth
limit and no visibility check. When a host paragraph's visible text box's own
interior paragraph mixes (a) a plain visible run and (b) a second run holding
a NESTED drawing whose `w:txbxContent` interior carries a `w:vanish` run,
`extractBlobText` walks straight through the nested boundary and
concatenates the hidden run's text into the SAME `CapturedObjectText` as the
outer paragraph's own visible text (`'Outer visible' + 'NESTED SECRET'` → one
leaked string, confirmed empirically against an unmodified checkout). The
issue also named a same-paragraph variant with no nesting at all: two sibling
runs in one interior paragraph, one plain and one `w:vanish` — concatenated
the same way, for the same reason.

Two existing mechanisms could have caught this but neither does, and the gap
is why this is a distinct defect from #515/ADR-087, not a re-run of it:
`body-text-box-visibility.ts`'s `collectTxbxContentNodes` deliberately does
NOT recurse into a `w:txbxContent` once found (a text box's interior is
treated as the opaque unit for the box-level hidden/visible correlation), so
a nested boundary never enters `hiddenSubtrees`. And
`header-footer-region.ts`'s `collectRunsAndFields` stops descending at each
`w:r`, so a run nested inside a text box's interior is never classified for
the box-level `hiddenFlags` array at all. Both truncations are internally
consistent with each other (one boundary found, one flag computed), which is
exactly why `resolveHiddenTxbxContentNodes`' fail-closed count guard (ADR-087
decision 2) never fires — the object is still captured, only its **text** is
wrong.

**#633 — a REFUTATION, not a defect: `hidden-text.integration.test.ts`'s
assertion never accounted for ADR-072 decision 14.** The issue reported that
`hidden-text.integration.test.ts`'s "no node's trimmed text is 5+ asterisks"
assertion fails deterministically against `hidden-text-test.docx`, with 4
leaked `objectText` nodes traced to `body-objects.ts`'s interior-paragraph
capture path never routing through `isRuleRow`/`classifyOne`'s suppression
(ADR-086). The issue itself flagged two possible directions and asked for an
investigation rather than a blind port: (a) route object capture through the
same rule-row check, or (b) if verbatim retention is intentional, fix the
test. Direction (a) was implemented FIRST and immediately broke an existing,
independently-passing, deliberately-scoped regression test:
`note-region-corpus.integration.test.ts`'s "DOCX object-table verbatim
rendering — hidden-text-test.docx (#300, ADR-072)" test, which asserts this
EXACT SAME fixture's body table renders EXACTLY 4 verbatim asterisk-rule
cells — the SAME 4 nodes `hidden-text.integration.test.ts` was flagging as
"leaked." That test's own header comment states the governing rule
explicitly: *"a captured table/text-box's cell text is a faithful,
out-of-band, VERBATIM mirror of the original document — never re-run through
the paragraph-tier note-region engine... Suppressing it would mean silently
reinterpreting locked table content, the opposite of this file's own
no-silent-loss contract."* This is ADR-072 decision 14, already shipped as
part of #300, and it applies to text boxes exactly as much as tables (the
comment names both). `hidden-text-test.docx` is even already carved OUT of
`note-region-corpus.integration.test.ts`'s corpus-wide asterisk sweep for
precisely this reason (`OBJECT_VERBATIM_TABLE`).

So the two tests encode CONTRADICTORY expectations for the SAME 4 nodes, and
the contradiction predates this ADR — `hidden-text.integration.test.ts`'s
assertion was written before #300/ADR-072 introduced object-table capture
and was never reconciled with it. Direction (a) (suppress rule rows inside
captured objects) resolves the contradiction by breaking the OLDER,
independently-reasoned, still-correct invariant. Direction (b) — narrow
`hidden-text.integration.test.ts`'s assertion to the paragraph-tier content
it actually intends to guard — resolves it without touching parser behavior
at all, and is what this ADR adopts.

## Decision

**1. `collectText` skips a `w:r` flagged by a new `hasRunVanish` predicate,
at whatever depth it is encountered (#641 fix).** `hasRunVanish(node)` is
presence-only — true iff `node` is tagged `w:r` and has a direct `w:rPr`
child that itself has a direct `w:vanish` child — mirroring `document.ts`'s
`paragraphMarkVanish` presence-only convention, but reimplemented on
`body-objects.ts`'s own `ObjectBlobNode` (preserveOrder-mode blob tree)
navigation trio (`tagOf`/`childrenOf`/`directChildrenByTag`), the same
self-contained per-module-helper pattern `body-text-box-visibility.ts`
already established rather than reaching into `document.ts`'s internals.
`collectText`'s existing recursive walk already passes transparently through
every wrapper it doesn't specifically stop at — including a nested
`w:txbxContent` boundary, since neither `collectText` nor anything upstream
of it treats that tag specially. Adding one check — "is this `w:r` a vanish
run?" — ahead of the recursive descent closes BOTH #641 shapes with one
mechanism: a vanish run nested several levels inside another text box's
interior is skipped the same way a vanish run sitting directly in the outer
interior paragraph is, because both are just `w:r` nodes the SAME walk
visits.

**Deliberately NOT extending `hiddenSubtrees`/`hiddenFlags` to nested
boundaries.** ADR-087 decision 7 names the general risk this design exists
to avoid: "any future grouped-side signal must be derived from the same
normalized view the blob keeps, or it must carry its own correspondence
proof" — and the #636 near-miss (hidden flags collected from the
un-normalized raw tree while `w:txbxContent` boundaries came from the blob
AFTER `stripAlternateContentFallback`, producing a 2-flags-vs-1-boundary
mismatch that silently suppressed the VISIBLE box) is the concrete failure
this class of bug produces. Teaching `body-text-box-visibility.ts` to also
correlate NESTED `w:txbxContent` boundaries against a nested
`isHiddenTextBox` classification would reintroduce exactly that risk one
level deeper, for content this ADR does not need box-level correlation to
fix. `hasRunVanish`/`collectText` instead derive their answer entirely from
the SAME `ObjectBlobNode` tree the anchoring walk already holds a reference
to — no second tree, no positional correlation, no fail-closed guard needed
because there is nothing to desynchronize.

**Scope limit, recorded rather than silently narrowed:** `hasRunVanish` is
presence-only. It does not evaluate `w:vanish/@w:val="0"` (an explicit
un-hide, vanishingly rare in practice) and does not resolve a
character-style-referenced vanish (`w:rStyle` pointing at a style whose own
`rPr` carries `w:vanish` — `document.ts`'s `runIsVanish` does this via a
`vanishCharStyleIds` set built from a `StyleMap`, which this leaf-level
blob-tree walk does not thread through). If full-corpus revalidation ever
surfaces a leak traceable to one of these narrower cases, it is a new,
separately-triaged defect — not evidence this ADR silently under-scoped
`hasRunVanish`; the full corpus (705 fixtures, `pnpm fixture:diff`) showed no
such case at the time of this fix (see Consequences).

**2. `body-objects.ts` gets NO rule-row/`isRuleRow` suppression branch —
object-captured interior text stays verbatim, exactly as ADR-072 decision 14
already decided (#633 resolved as direction (b), a test fix).**
`transformChildren`'s `w:p` leaf-eligibility guard is UNCHANGED
(`text.trim().length === 0`, the pre-existing empty-paragraph check). No
`isRuleRow` import, no new predicate, no behavior change to
`buildTableObject` or `buildTextBoxObject`.

**3. `hidden-text.integration.test.ts`'s bare-asterisk assertion is narrowed
to exclude `objectText` nodes**, with a comment citing ADR-072 decision 14 and
`note-region-corpus.integration.test.ts`'s `OBJECT_VERBATIM_TABLE`-scoped
regression test for this same fixture. The assertion's INTENT — no
paragraph-tier asterisk-rule wall survives suppression (ADR-086) — is
unchanged and still enforced for every node type that can carry a
paragraph-tier verdict; only the object-capture carve-out this test never
had is added. Mutation-verified: temporarily disabling `classifyOne`'s
`role === 'rule'` branch (ADR-086's own suppression) still fails this
narrowed assertion, proving it is not vacuous — it does not exclude
`objectText` so broadly that it stops catching real paragraph-tier
regressions.

**4. Both predicates/changes are scoped to what they touch and nothing
else.** `hasRunVanish`/`collectText`'s signature is unchanged (`(children,
acc) => void`); `extractBlobText`'s observable contract (concatenation of
every non-suppressed `w:t` reachable from a node) changes only in which text
counts as "non-suppressed" for VANISH runs — rule-row text is untouched, at
any depth, inside any object capture.

## Consequences

- A visible outer text box containing a hidden nested text box now exposes
  only its own visible text in `interiorTexts`; the nested box's OOXML is
  untouched byte-for-byte inside the opaque blob (`transformInteriorParagraphs`
  never rebuilds a node whose text collection changes — only which text is
  RECORDED changes, never the tree structure returned). Pinned in
  `body-objects.test.ts` by a byte-identity assertion comparing the nested
  `w:txbxContent` boundary's serialized bytes from two independently-built
  trees (pre-extraction blob vs. post-extraction captured blob) for exact
  string equality — not substring containment.
- `hidden-text.integration.test.ts` goes green from the TEST change in
  decision 3 alone — `body-objects.ts` is unchanged with respect to rule-row
  content. `note-region-corpus.integration.test.ts`'s pre-existing
  object-table-verbatim regression test is UNCHANGED and stays green
  throughout — this was the tripwire that caught direction (a)'s
  correctness error before it shipped.
- Full-corpus revalidation (`pnpm fixture:snapshot`/`pnpm fixture:diff`, 705
  fixtures) against the FINAL `body-objects.ts` (the #641 run-vanish fix
  only, no rule-row change): 0/705 fixtures changed. No fixture in the corpus
  exercises the #641 nested-text-box shape either, so decision 1 is
  unverified against real-world documents beyond the hand-built regression
  fixtures in `body-objects.test.ts` — expected, logged here rather than
  silently assumed identical.
- `hasRunVanish`'s presence-only scope (no `w:val="0"` negation, no
  `w:rStyle` character-style resolution) is a documented boundary, not a
  silent gap — see decision 1. A future report of a leak traceable to either
  narrower case is new evidence, not proof this ADR mis-scoped the fix.
- No public/exported struct changed: `CapturedObjectText`, `CapturedBodyObject`,
  `ChildrenTransformResult`/`InteriorTransformResult`, and every `ObjectBlobNode`
  shape are byte-for-byte unchanged — this ADR only changes which text
  `collectText` records for VANISH content, and changes one test's scope.
- Cross-references: ADR-087 (per-text-box visibility) decision 7's
  same-normalized-view rule is the reasoning this ADR follows by NOT
  extending `hiddenSubtrees`/`hiddenFlags` correlation to nested boundaries;
  ADR-072 decision 14 (#300) is the ALREADY-DECIDED rule this ADR discovered
  #633's report conflicts with, and defers to rather than silently
  overriding; ADR-086 (asterisk rule rows stay suppressed, not notes) governs
  the PARAGRAPH-tier flow only and is untouched — `inference.ts`,
  `classifyOne`, and `note-roles.ts` are not modified by this ADR; ADR-072
  addendum 20's open nested-object-promotion questions remain open and
  unaffected.
