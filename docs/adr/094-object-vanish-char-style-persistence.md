# ADR-094: persist resolved vanish character-style IDs on the captured object, not `styles.xml`

## Status

Accepted

## Context

ADR-092 shipped `hasRunVanish` with a recorded scope limit: it resolves a
direct `w:rPr>w:vanish` on a run, but not a `w:vanish` reached indirectly
through `w:rPr>w:rStyle` naming a character style that itself carries
`w:vanish`. `document.ts`'s `runIsVanish` (the paragraph-tier equivalent)
already resolves this, via a `StyleMap.vanishCharStyleIds` set built once
from `styles.xml` at parse time. The object-capture tier was the odd one
out — #650 measured the gap as unreachable across the 39-file DOCX corpus
(0 files reference a vanish character style via `w:rStyle`) but reachable in
production, since a Word user can define a hidden character style trivially.
Left as-is it is a privacy leak of the same class as #515/#641: hidden text
surfacing in `objectText`, the API, and rendered output.

**Why the obvious fix — teach `hasRunVanish` to also resolve `w:rStyle`
using the `StyleMap` already in scope at parse time — is wrong.**
`hasRunVanish` is exported specifically so capture (`collectText` in
`body-objects.ts`) and edit rewrite (`object-blob-edit.ts`'s
`rewriteFirstText`) share one definition; a second, drifting copy is what
produced the P1 caught on PR #647 (ADR-092). But `rewriteObjectTextBlob`
(`src/db/queries/object-text-edit.ts`) reads a persisted `object_data` JSONB
row inside an open transaction — there is no `styles.xml` there and no route
to a `StyleMap`. `styles.xml` is a separate OOXML part the captured blob
never contained (ADR-072 decision 1: objects round-trip as an opaque blob).
Fixing only capture's `hasRunVanish` call site would desynchronize it from
rewrite: capture would start skipping style-vanished runs rewrite still
cannot see, and an edit could land in a skipped (hidden) run while blanking
the visible one — over-suppression that is worse than the original leak
(ADR-092's own asymmetry principle: a missed suppression is a detectable
visible leak, a wrong suppression is invisible data loss).

## Decision

**Persist the resolved vanish character-style ID set alongside the captured
object**, so capture and rewrite read one shared, already-resolved source of
truth and never need `styles.xml` at rewrite time.

1. `ObjectMetaSchema` (`src/ast/object-schemas.ts`) gains an additive,
   optional `vanishCharStyleIds: string[]` field — JSONB, no migration.
   Absent and `[]` are fully interchangeable (today's behaviour: no run
   treated as hidden by style), so a pre-#650 row loads and edits unchanged.
   Persisted as a **sorted** array, never a `Set`, so the JSONB column and
   fixture snapshots serialize deterministically.
2. Capture: `extractBodyObjects` already receives the `StyleMap`, so
   `CapturedBodyObject.vanishCharStyleIds` carries the FULL resolved set
   forward unfiltered (not narrowed to what this object actually
   referenced — simplicity, zero correctness cost), and
   `body-object-attach.ts`'s `toObjectMeta` persists it.
3. `hasRunVanish` (`body-object-vanish.ts`, split out of `body-objects.ts`
   purely to stay under the file's line budget) takes the set as a
   parameter — a straight OR port of `document.ts`'s `runIsVanish`: hidden
   if EITHER the run's own `w:rPr>w:vanish` is an enabled ST_OnOff toggle
   OR its `w:rStyle` names an id in the set. No special-casing between the
   two signals.
4. Rewrite: `rewriteObjectTextBlob` reads `meta.vanishCharStyleIds ?? []`
   off the SAME row it already loaded and threads it into
   `replaceAnchoredParagraphText` → `rewriteFirstText`'s `hasRunVanish`
   call — one predicate, both directions, no `styles.xml` needed.
5. Backfill: explicitly refused. A row captured before this change carries
   no set and none can be re-derived (the originating `styles.xml` is not
   stored anywhere) — it keeps today's behaviour (empty set) until its
   source document is re-imported. No fabricated backfill.

**Adversarial-review finding folded in: the generator never wrote a
`w:styles` character-style section at all**, so a captured object's blob
(byte-identical, `w:rStyle` reference included, per ADR-072 decision 1)
regenerated into a DOCX whose `styles.xml` no longer defined the referenced
character style. Re-opening or re-parsing that file resolved
`vanishCharStyleIds` back to empty and the previously-hidden run surfaced as
plain visible text — a real regression, not a hypothetical, caught by
`body-object-round-trip.test.ts`'s own round-trip case for this fix.
`object-vanish-styles.ts` closes it: `collectVanishCharacterStyleIds` unions
every captured object's `vanishCharStyleIds` across the tree(s) being
generated, and `vanishCharacterStyleOptions` emits one minimal
`w:type="character"` style stub per id — carrying only an enabled
`w:vanish`, nothing else of the original style (font, color, basedOn
chain — SpecR does not retain the source `styles.xml` to reconstruct them,
and none of it affects vanish resolution). `generateDocx`/`generateManual`
emit this stub set only when at least one captured object actually
references one, keeping the overwhelmingly common case byte-identical to
pre-#650 output.

**Second adversarial-review finding: `generateManual` combines multiple
source trees into one `styles.xml` namespace.** Two different source
documents can each define their OWN character style under the SAME id — one
genuinely vanish, one used only for bold/underline on visible text. Sharing
one namespace lets one tree's minted vanish stub silently overwrite another
tree's unrelated same-named style, hiding text the other tree's own capture
correctly resolved as visible. `object-vanish-namespace.ts`'s
`namespaceVanishTrees` fixes this by giving every source tree its own
private namespace (`<id>#specr-vanish-t<treeIndex>`) for the ids its OWN
captured objects reference — renaming both the `w:rStyle` references in that
tree's own object blobs and the `vanishCharStyleIds` entries themselves.
Deliberately unconditional (every tree with any vanish ids is namespaced,
not only on a detected same-id collision): detecting a real collision would
need scanning every OTHER tree's blobs for a non-vanish reference to the
same id, a larger walk for a case the cheap unconditional rename already
makes moot — the renamed id is never read back by SpecR (it is shown to a
human in Word, never a correlation key). A no-op — every tree and the whole
array returned BY REFERENCE — for `trees.length <= 1` or when no tree
carries any vanish ids, so `generateDocx` (always exactly one tree) and the
overwhelmingly common manual case are unaffected.

## Consequences

- `ObjectMetaSchema`'s cross-field check also now couples `SpecNodeSchema`'s
  `type`/`meta.object` presence (an `'object'` node requires `meta.object`
  and no other node type may carry one) — a structural hardening discovered
  auditing `.shape`-spread consumers of these schemas for the new field, not
  a `vanishCharStyleIds`-specific rule.
- ADR-092's "Scope limit, recorded rather than silently narrowed" paragraph
  is superseded by this ADR — see the amendment there.
- `openapi.yaml` documents `vanishCharStyleIds` on the object-meta schema.
- No DB migration: additive JSONB field on `paragraphs.object_data`.
- Full-corpus revalidation (`pnpm fixture:snapshot`/`pnpm fixture:diff`, 705
  fixtures): addition-only, 0 fixtures moved — no corpus file exercises a
  `w:rStyle`-referenced vanish character style (measured in the issue), so
  this closes a production-reachable gap the corpus itself cannot exercise
  end-to-end; coverage instead comes from hand-built fixtures in
  `body-object-round-trip.test.ts` and `object-schemas.test.ts`.
- Cross-references: ADR-092 (the predicate and split-file this ADR extends);
  ADR-072 decision 1 (opaque blob round-trip — why `styles.xml` cannot be
  read at rewrite time, and why the generator stub reconstructs nothing
  beyond the vanish toggle); PR #536 (the additive-field-does-not-persist
  trap this ADR's write/read-path wiring and round-trip tests were written
  against).
