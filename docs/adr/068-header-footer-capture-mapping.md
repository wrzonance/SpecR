# ADR-068: DOCX header/footer capture → structured config mapping

## Status

Accepted

## Context

ADR-040 (#302) shipped the AST schema layer for header/footer v2 —
`variants` (default/first/even), `pageNumbering`, and an open `raw` sidecar
on `HeaderFooterCompositionSchema` — but explicitly deferred "capturing
header/footer OOXML during parse" to this issue, #306. That ADR also
records that its own two cited design documents
(`docs/superpowers/specs/2026-06-26-header-footer-fidelity-design.md`,
`docs/adr/039-header-footer-fidelity.md`) do not exist; #306's own body
still points at both. This ADR is the real record for the capture side, as
ADR-040 was for the schema side.

The task: read `word/header*.xml`, `word/footer*.xml`,
`word/document.xml`'s section properties, `word/document.xml.rels`, and
`word/settings.xml` out of the DOCX zip; map recognizable content
(literals, known fields, simple rule lines, spec number/title) into the
v2 composition; and preserve everything else in `raw` with a warning —
never silently drop it. A pre-implementation spike surfaced several
corrections to the original task design, recorded below alongside the
decisions themselves so a future reader sees _why_, not just _what_.

### Two prerequisite extractions

Landing the capture pipeline in `src/parser/docx/index.ts` pushes that
file over the repo's 400-line cap (`eslint.config.js`, tightened from the
global 800 by `CLAUDE.md`). A single extraction of
`detectSource`/`detectArticleIlvl` (`source-detection.ts`, commit
`987f56c`) was not sufficient headroom by itself; `parseCoreMetadata` and
its `XMLParser` instance were also extracted verbatim
(`core-metadata.ts`, commit `defb1c5`), and the `src/ast/schemas.ts` file
— independently over budget at 407/400 lines — was split into
`spec-tree-schemas.ts` (commit `ee752d9`) so the new
`ParseWarningType` literal and `SpecTree.headerFooter` field have a home
under budget too. All three are zero-behavior-change refactors, landed
ahead of and independently of the capture feature itself; `index.ts`
sits at 323/400 lines afterward, matching this ADR's estimate of the
header/footer wiring's footprint.

## Decision

### Scope: the single trailing section

A DOCX body can contain multiple `w:sectPr` (one per section break,
`w:pPr/w:sectPr` on the last paragraph of each section, plus the
body-level trailing one for the final/only section). This capture reads
**only the body-level trailing `w:sectPr`** — the common case for a
single-section spec section master. Any `w:pPr/w:sectPr` found elsewhere
in the body sets `hasAdditionalSectionBreaks: true` on the parsed
section info and is surfaced through `raw.warnings` /
`header-footer-content-skipped`, rather than being modeled as a second,
independent header/footer set. Modeling per-section header/footer
sequences is deferred; nothing here prevents adding it later, since the
warning already flags which documents would need it.

### Reference resolution: variant × region pairs, not a path-keyed map

Word ties a header/footer to a section via `r:id` references
(`w:headerReference`/`w:footerReference`, each carrying `w:type` ∈
`default|first|even`) resolved through `word/document.xml.rels`.
`resolveReferenceTargets` returns `{ resolved: (reference, target)[],
unresolved: reference[] }` rather than a `Map` keyed by target path.
Two different reference slots can legitimately resolve to the same
physical part (e.g. `default` and `even` both pointing at
`header2.xml` because the author never customized the even-page
header); a path-keyed map would silently collide those into one entry.
The caller filters the array by `(variant, region)`, which costs nothing
extra at the real cardinality (at most six references per document) and
removes the correctness dependency on target-path uniqueness entirely.

### Toggle-off references: `inactiveVariant`, distinct from `unresolvedReference`

A `first`/`even` reference can resolve to a real relationship target
while the section's own toggle is off (`w:titlePg` absent for `first`,
`w:evenAndOddHeaders` absent for `even` in `word/settings.xml`). Word
itself does not render that variant. Promoting it into
`variants.first`/`variants.even` would fabricate render behavior the
source document doesn't exhibit; dropping it silently would violate
acceptance criterion 4 ("no unsupported H/F content is silently
discarded"). It is captured into `raw.unmodeled` under a sixth kind,
`inactiveVariant`, distinct from `unresolvedReference` (a reference
whose `r:id` has no matching relationship at all — a different failure
mode with a different remediation). Each contributes exactly one
`raw.warnings` entry; `variants.first`/`variants.even` are populated
**only** when the corresponding toggle is on.

### Table detection is a structural fact, not a heuristic

OOXML tables (`w:tbl`) cannot nest inside a paragraph (`w:p`) — a
`w:tbl` is a root-level sibling of `w:p` within a header/footer part,
never a descendant of one. Table detection scans the part's root-level
direct children, not the run sequence inside the captured paragraph.
Scanning inside the paragraph (the original task sketch's phrasing) would
simply never find a table, silently mis-classifying every part that
contains one as table-free instead of flagging it as unmodeled content.

### At most one captured paragraph per part; the tab-boundary split is a KNOWN AMBIGUITY

`HeaderFooterRegionSchema` (ADR-040) models one `{ left, center, right }`
row per header/footer part — matching the common 3-tab-stop DOCX
header/footer convention. The first paragraph with recognizable content
in a part is split into left/center/right on **tab boundaries**: 0 tabs →
all content in `left`; 1 tab → `left`/`right` (or `left`/`center`
depending on the tab's alignment — center-aligned by convention); 2 tabs
→ `left`/`center`/`right`. A run with **3 or more tabs** has no fourth
cell to hold the extra content: per `CLAUDE.md`'s OOXML ambiguity rule,
this is pinned as a `// KNOWN AMBIGUITY` test, not silently resolved —
the fourth-and-later segment folds into `right` and the part additionally
emits an `unmodeled { kind: 'unrecognizedField' }` entry plus a warning,
so the extra content is preserved even though its intended cell
placement cannot be recovered. Any **second or later** paragraph with
recognizable content in the same part is entirely `unmodeled { kind:
'extraParagraph' }` — never merged into or overwriting the first
paragraph's capture.

### Page-numbering policy is read from `w:pgNumType`, restart-per-part is not inferred

The trailing `w:sectPr`'s `w:pgNumType/@w:start` attribute, when present, is
read into `sectionInfo.pgNumStart`. This capture does not attempt to infer
`pageNumbering.mode` (`continuous` vs `restartPerSpec`) from a single
document's section properties — that policy is inherently a cross-document,
package-level decision (ADR-040 already scopes it that way), not recoverable
from one spec section's OOXML.

**Correction (post-implementation review, #306):** `PageNumberingSchema.mode`
(ADR-040) is a _required_ field whenever `pageNumbering` is present at all —
there is no schema-valid way to write `pageNumbering: { startAt }` without
also supplying `mode`, and fabricating a `mode` here would be exactly the
guessed cross-document policy this section already rules out. `pgNumStart` is
therefore preserved verbatim under `raw.pgNumStart` (the sidecar's open
catchall) with a matching `raw.warnings` line, not promoted to
`composition.pageNumbering.startAt`. `mode` and the promotion decision both
remain for the caller/resolver (#304) to set.

### Field recognition is core.xml-literal, never content-inferred

Recognized `sectionNumber`/`sectionTitle` field references are matched
against the section's `meta.section`/`meta.title` — computed once by
`parseCoreMetadata` from `docProps/core.xml` (extracted to
`core-metadata.ts` per above) and passed into the capture unchanged.
Field recognition never falls back to the later content-inference engine
result (the 5-signal engine's own derived title), and never guesses a
field reference from a partial text match. Any header/footer text that
does not literally match `meta.section` or `meta.title` — including a
recognized-but-unmapped Word field code (`matchKnownSectionField`'s
`'unknown'` sentinel) — is captured as a `literal` field, never a
guessed `sectionNumber`/`sectionTitle` reference. This satisfies
acceptance criterion 2 ("map to field references, not copied text
values, **when possible**") honestly: when it isn't decidably possible,
the literal fallback is the correct, non-fabricated answer.

### `raw` is a JSON-safe parsed sidecar, not re-serialized OOXML

Every `raw.unmodeled` entry's `detail` is the already-parsed
(fast-xml-parser) fragment for the unsupported node, passed through the
module's existing `compact()` helper (`xml-utils.ts`) before
construction — never the original XML string re-serialized, and never an
unvalidated pass-through. This keeps `raw` uniformly JSON-safe (matching
`z.json()`'s contract) and guarantees the composition object's single
`HeaderFooterCompositionSchema.parse()` call at the end of
`captureHeaderFooter` cannot fail on a document-content path: an
unmodeled OOXML shape is captured as-is, JSON-shaped, rather than risking
a validation failure mid-build. If that final `.parse()` ever does throw,
it is treated as an uncaught internal defect in the capture code, never
remapped to the new `DOCX_HEADER_FOOTER_XML_INVALID` error code — that
code is reserved strictly for malformed-but-present
`word/settings.xml`, `word/document.xml.rels`, or
`word/header*.xml`/`word/footer*.xml`, so an internal shape bug is never
misattributed to the source document.

### `header-footer-schemas.ts` (#302) gets one small additive edit

The original task design instructed that ADR-040's schema file be left
untouched — `raw`'s existing `warnings?: string[]` was assumed to be
enough to satisfy acceptance criterion 3 ("preserved in raw sidecar and
warned"). Implementation proved that assumption wrong: `warnings` is a
list of _message strings_, with nowhere to put the actual preserved
_content_ (the unsupported paragraph, image reference, or table
fragment itself). Storing that content as an untyped `unknown` also
does not type-check against `z.json()`'s inferred type without an
`as unknown as` cast, which this repo's TypeScript strictness forbids.

The fix is a small, backward-compatible, additive schema change, not a
workaround:

```typescript
export const HeaderFooterUnmodeledEntrySchema = z.object({
  variant: z.enum(['default', 'first', 'even']),
  region: z.enum(['header', 'footer']),
  kind: z.enum([
    'image',
    'table',
    'unrecognizedField',
    'unresolvedReference',
    'extraParagraph',
    'inactiveVariant',
  ]),
  detail: JsonValue,
});
```

added as `unmodeled: z.array(HeaderFooterUnmodeledEntrySchema).exactOptional()`
on `HeaderFooterRawSidecarSchema`, alongside the pre-existing
`warnings?: string[]`. `HeaderFooterRawSidecarSchema` already has its own
`.catchall(JsonValue)` and a local `JsonValue` constant independent of
`src/ast/schemas.ts`/`spec-tree-schemas.ts`, so there is no circular-import
risk from this change. Every pre-#306 `HeaderFooterComposition` value —
with or without `raw`, with or without `warnings` — continues to parse
unchanged; `unmodeled` is additive-optional, matching the backward-compat
posture ADR-040 already established for this file.

### Addendum (2026-07-15, #484): standalone border-only paragraphs are no longer silently dropped

`captureFromParagraphs` filtered to `contentBearing = paragraphs.filter((p) =>
paragraphHasContent(runsOf(p)))` and read the rule line only from
`contentBearing[0]`'s own `w:pBdr`. A header/footer horizontal rule
authored as its own otherwise-empty paragraph — `w:pPr/w:pBdr` with no
runs at all — is never content-bearing (`paragraphHasContent` only
recognizes `w:t`/`w:fldChar`/`w:instrText`/`w:drawing`/`w:pict`), so it was
filtered out before `captureRuleLine` ever ran on it: no `region.ruleLine`,
no `raw.unmodeled` entry, no warning. This violated acceptance criterion 4
above for two concrete shapes: a part whose only content is a standalone
rule line, and a leading standalone rule-line paragraph above a text
paragraph.

**Decision:** a new `resolveRuleLine` helper scans every paragraph in the
part (not just the first content-bearing one) for a qualifying border,
position-agnostically — leading, trailing, or the sole paragraph are all
treated identically, since OOXML gives no structural reason to special-case
position. When the content-bearing paragraph carries no border of its own,
the first such standalone paragraph is **promoted** into `region.ruleLine`;
any further standalone match **demotes** to an `unmodeled { kind:
'extraParagraph' }` entry, reusing the existing kind rather than adding a
new one (a single-issue fix keeps its schema footprint at zero).

**KNOWN AMBIGUITY:** when a part has _both_ a standalone rule-line
paragraph and a content-bearing paragraph that also carries its own
border, OOXML gives no canonical tiebreak for which one is "the" rule
line. The content-bearing paragraph's own border wins outright — matching
the pre-existing "first content-bearing paragraph wins" convention this
ADR already established above — and the standalone paragraph demotes to
`unmodeled` rather than being merged or silently dropped. This is
`// KNOWN AMBIGUITY`-pinned per `CLAUDE.md`'s OOXML ambiguity rule in
`header-footer-region.test.ts`.

A genuinely empty, borderless, content-less paragraph is unaffected and
remains silently unreported — that paragraph carries no signal at all, so
there is nothing to preserve; this is unchanged pre-#484 behavior, called
out here so it is not mistaken for a remaining gap. No schema change:
`resolveRuleLine`'s return shape is local to `header-footer-region.ts` and
`captureFromParagraphs`'s existing `{ region, unmodeled }` return type is
unchanged.

### Addendum (2026-07-16, #502): a header/footer part's own corrupt `.rels` degrades per-part, never fails the whole capture

Prior to #502, a single damaged `word/_rels/header*.xml.rels` or
`word/_rels/footer*.xml.rels` — malformed XML, or a `.rels` entry JSZip
itself could not decompress — aborted `readHeaderFooterMedia` with a thrown
`ParserError`, failing the entire DOCX parse over one damaged part's image
relationships. This reverses that failure mode to a per-part degrade,
mirroring every other unsupported-content case this ADR already documents
(images, tables, extra paragraphs, inactive variants): preserved as an
`unresolvedReference` and warned about, never silently dropped, never
fatal. **This policy reversal was confirmed with the user issuing #502 and
is not open for re-litigation in a future PR** — a future contributor
proposing to restore the hard-fail behavior needs a new issue and a new
ADR entry, not a quiet revert here.

**`readHeaderFooterMedia`'s new contract:** a part absent from
`HeaderFooterMediaByPart` still means what it always meant — "no `.rels`
file exists for this part at all," not an error. A part _present_ in the
map now means its `.rels` file existed and was attempted: either
`{ status: 'resolved', media }` (the pre-#502 behavior, unchanged) or
`{ status: 'relsUnreadable', partPath }` — the `.rels` file's own XML was
malformed, or JSZip could not read/decompress the entry. `readPartMedia`'s
single `try`/`catch` spans both failure points and never rejects.

**`document.xml.rels` and part-XML-itself strictness are unchanged — and
that distinction is deliberate, not an oversight.** #502 only ever
degrades a header/footer part's own `.rels` file (an image-relationship
index one layer removed from the part's rendered content). It does
**not** touch:

- `word/document.xml.rels` (top-level relationships resolving
  `w:headerReference`/`w:footerReference` `r:id`s to part targets) —
  `parseDocumentRelationships` still throws `DOCX_HEADER_FOOTER_XML_INVALID`
  unchanged, now pinned through `captureHeaderFooter`'s own orchestrator
  boundary, not just at its own module boundary.
- The header/footer part's own body XML (`word/header*.xml`,
  `word/footer*.xml`) — a malformed part still throws unchanged, via
  `buildVariant`/`captureRegion`, exactly as before #502.

A document can combine both: a header whose own `.rels` is corrupt (which
now degrades) sitting alongside a footer whose _own body XML_ is malformed
(which still throws) — the two failure modes coexist without one masking
the other, because they are structurally independent code paths
(`readHeaderFooterMedia`'s async extraction phase vs.
`captureRegion`/`parseDocumentRelationships`'s synchronous parse), not a
single generalized try/catch (INV-10, pinned end-to-end through
`captureHeaderFooter`). `DOCX_HEADER_FOOTER_XML_INVALID`'s scope is
therefore _narrower_ after #502 than before: it no longer covers "a
header/footer part's own `.rels` is unreadable" (that case now degrades),
but still covers every other genuinely-malformed-source-XML case this ADR
already reserves it for (settings.xml, document.xml.rels, and each
header/footer part's own body XML).

**`unresolvedReference` is reused, not a new kind.** A `relsUnreadable`
degrade is captured under the SAME `unmodeled.kind: 'unresolvedReference'`
the schema (this ADR, above) already defines for "a reference that cannot
be resolved" — an `r:id` with no relationship at all is one flavor;
"every `r:id` in this part is unresolvable because its own relationship
index is unreadable" is another. Both share the same remediation category
(the reader cannot recover the referenced image without going back to the
source document) and the same schema shape (`detail: JsonValue`), so a
sixth `unmodeled` kind would have added schema surface with no behavioral
payoff. The three pre-existing `unresolvedReference` producers
(`missingPartEntry`, `unresolvedToUnmodeled`, `duplicateReferenceEntry`)
key their `detail` on `target`/`rId` alone and never set a `part` field;
a `relsUnreadable` degrade's `detail` always carries `part` (plus
`reason`, and `rId` only at the paragraph-level path — the table-cell
path never parses a drawing descriptor, so it has no `rId` to carry).
This `part`-field presence is what `isRelsUnreadableDetail`
(`header-footer-media-warnings.ts`) matches on to separate a
`relsUnreadable` entry from the three pre-existing producers, verified
against all three explicitly rather than assumed disjoint.

**Table-cell drawings are counted too (ADR-071 decision 4 stands).** The
issue's own prior art names `collectCellParagraphs` explicitly, so a
table-cell drawing in a damaged part degrades to `unresolvedReference`
and is counted into that part's aggregate warning, exactly like a
paragraph-level drawing. ADR-071 decision 4 — table-cell images never
become modeled content, regardless of rels-index health — is unchanged:
`captureTableCell`'s `buildCellContent` call is still made _without_
`partMedia`, so a table-cell image can degrade to `unresolvedReference`
but can never be promoted to a modeled `image` field. One asymmetry is
worth naming explicitly (INV-2/INV-3): the paragraph-level path
(`resolveDrawingImage`) checks `parseDrawingDescriptor` validity _before_
checking rels health, so a structurally malformed drawing (missing
`wp:extent`, say) keeps the generic `kind: 'image'` fallback
unconditionally, even against a `relsUnreadable` part (INV-2). The
table-cell path has no equivalent descriptor gate — `isDrawingRun` is a
coarse `'w:drawing' in run` check, matching today's pre-existing coarser
pre-filter — so _any_ drawing-bearing run in a `relsUnreadable` table
cell becomes `unresolvedReference`, even one that would itself have
failed descriptor parsing at the paragraph level (INV-3). This is a
documented asymmetry, not an oversight: the table-cell layer never had a
descriptor gate before #502 either, and #502 does not add one.

**One aggregate warning line per damaged part, not one per drawing.**
`buildRelsUnreadableWarnings` groups matching `unmodeled` entries by
`detail.part` into `Map<string, number>` and emits exactly one line per
unique part — `"${part}'s relationships index is unreadable; ${count}
image reference(s) could not be resolved"` — only when that part's count
is greater than zero. The same physical part referenced by two different
variant slots (e.g. `default` and `first` both resolving to
`header2.xml`) dedupes naturally through this grouping, matching this
ADR's own "two references, same physical part" pattern above. A damaged
part with zero qualifying drawings — its `.rels` is corrupt but the part
happens to contain no images at all — emits no warning; there is nothing
to attribute a warning to. `buildRawWarnings` excludes every
`relsUnreadable`-matched entry from the generic per-entry
`unmodeledWarningLine` mapping and appends `buildRelsUnreadableWarnings`'
aggregate lines instead — the excluded entries remain in `raw.unmodeled`
untouched; only the _warning line_, not the preserved content, is
deduplicated.

**The caught error is discarded outright — a deliberate, narrow deviation
from this repo's "chain cause across boundaries" convention
(`CLAUDE.md`).** `readPartMedia`'s `catch` block returns
`{ status: 'relsUnreadable', partPath }` without constructing a
`ParserError`, without a `cause` chain, and without a logger call. This
was a spike finding, not the original design: constructing a
`ParserError` purely to immediately discard it (never thrown, since
throwing would defeat the whole point of degrading instead of failing)
trips this repo's own dead-code lint rules, and no file under `src/parser/`
imports the pino logger today — adding one here would be new,
unprecedented territory for a single warning line. The per-part warning
string (`RELS_UNREADABLE_REASON`, surfaced through
`buildRelsUnreadableWarnings`) is the _only_ context that survives past
the catch — the original XML parse error or JSZip decompression failure
is not recoverable from `raw.warnings` after the fact. This is accepted
as the right tradeoff for a source-document defect the reader cannot fix
by looking at a stack trace anyway (the fix is republishing a valid DOCX,
not debugging SpecR), but it is a real, named tension with this repo's
default error-handling posture, not a case quietly exempted from it.

## Consequences

- Acceptance criteria 3 and 4 are met by construction: every unmodeled
  item is both preserved (`raw.unmodeled`, JSON-safe) and warned about
  (`raw.warnings`, one aggregate `ParseWarning { type:
'header-footer-content-skipped' }` at the tree level iff `raw.warnings`
  is non-empty) — never silently dropped, never warned without the
  content actually being retained.
- `resolveReferenceTargets`'s array-of-pairs shape and the
  root-level `w:tbl` scan are both corrections to plausible-looking but
  incorrect approaches a straightforward reading of the task would have
  produced; both are now fixed facts for this module rather than latent
  bugs a later PR would have had to rediscover.
- The tab-boundary ≥3-tabs case and the multi-`w:sectPr` case are
  explicit, pinned `KNOWN AMBIGUITY` tests per `CLAUDE.md`'s OOXML
  ambiguity rule — not silently resolved, and not left undocumented.
- `header-footer-schemas.ts`'s `unmodeled` field is the only schema
  change in this slice; it does not touch `variants`, `pageNumbering`,
  or the v1 compat fields ADR-040 already shipped, and does not require
  a migration (JSONB, same as ADR-040).
- Out of scope, same as ADR-040 already noted for #304/#306 boundaries:
  applying `pageNumbering` during generation (#303), resolving captured
  config across the client → project → package → revision scope chain
  (#304), and any visual-fidelity round-trip verification beyond what
  this parse-capture slice can assert on its own (tracked against
  #150/#305). `SpecTree.headerFooter` is parse-output only in this
  slice — no DB/REST/MCP persistence of captured header/footer content
  is added here; wiring a captured composition into
  `header_footer_configs` (migration 030) is an explicitly separate,
  unscoped follow-up.
