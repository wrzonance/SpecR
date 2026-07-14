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
decisions themselves so a future reader sees *why*, not just *what*.

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
(ADR-040) is a *required* field whenever `pageNumbering` is present at all —
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
list of *message strings*, with nowhere to put the actual preserved
*content* (the unsupported paragraph, image reference, or table
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
