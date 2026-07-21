# ADR-075: page size capture and round-trip (`w:pgSz`)

## Status

Accepted

## Context

\#509: the generator (`sectionHeaderFooterOptions`, `src/generator/index.ts`)
has always emitted a hardcoded page size for every regenerated DOCX,
independent of what the source document actually declared in
`word/document.xml`'s `w:sectPr/w:pgSz`. A source authored on legal paper, or
landscape-oriented (a wide submittal-matrix table, a wiring-diagram sheet), is
silently regenerated on Letter/portrait — a fidelity gap in the same family
ADR-068/070/071 already closed for header/footer content, but never addressed
for the page itself.

A pre-implementation spike built the parser-side extraction and the
generator-side wiring against real corpus fixtures before this design was
finalized. It confirmed the shape below is sound and surfaced two corrections,
recorded in the Decision section: an `index.ts`/`header-footer.ts` file-budget
concern that turned out to be a false premise (both files are lint-clean
today and stay clean after this addition — eslint's `max-lines` uses
`skipBlankLines`/`skipComments`, not raw `wc -l`), and a cognitive-complexity
cap that forced the extraction function to be decomposed into two small
helpers plus a thin orchestrator.

## Decision

### 1. `PageSize` is all-or-nothing — width and height are always both present

`{ width: number, height: number, orientation?: 'portrait' | 'landscape' }`
(twips, mirroring `w:pgSz/@w:w`/`@w:h`) is captured as a complete unit or not
at all — never a partial `{ width: NaN }` shape. `PageSizeSchema`
(`src/ast/spec-tree-schemas.ts`) enforces the same invariant at the schema
boundary: `width`/`height` are required positive integers, `orientation` is a
closed two-value enum, `.exactOptional()` when absent (never fabricated).

### 2. `SpecTree.pageSize` is additive and kept in lockstep with `PageSizeSchema`

`SpecTreeSchema` has no `.catchall()` — unlike the open, `.catchall(JsonValue)`
sub-schemas used for header/footer and source-facts content (ADR-021's
"unknown-key preservation" posture doesn't apply to `SpecTree`'s own typed
fields). A field added to the `PageSize` TS type but not mirrored into
`PageSizeSchema` would silently vanish on every DB round-trip rather than
fail loud — so the type and schema are treated as one lockstep unit, landed in
a single commit, mirroring the same discipline already applied to
`hiddenTables` (ADR-038/#293) and `headerFooter` (ADR-068/#306). Absent ===
no explicit `w:pgSz` captured (or a non-DOCX source, e.g. `.SEC`).

### 3. Parser: a decomposed extractor, not one inline function

`extractPageSize(sectPr): PageSize | undefined`
(`src/parser/docx/header-footer-relationships.ts`) is composed from two small
helpers rather than one function, because the naive single-function version
measured cognitive-complexity 11 against this repo's cap of 10
(`eslint.config.js`, `sonarjs/cognitive-complexity`):

- `parsePositiveDimension(raw: unknown): number | undefined` — the shared
  width/height guard (`>0` AND `Number.isFinite`, stricter than
  `extractPgNumStart`'s `isNaN`-only guard: a zero/negative page dimension is
  unrenderable, not merely odd).
- `extractOrientation(sectPr): 'portrait' | 'landscape' | undefined` — mirrors
  the existing `isKnownVariant` drop-unrecognized-value precedent: kept only
  when `@w:orient` is exactly one of the two known values, never fabricated
  otherwise.
- `extractPageSize` itself is a thin ~6-line orchestrator over the two.

`parseSectionHeaderFooterInfo`'s signature is unchanged; it spreads
`pageSize` via the same conditional-spread idiom already used for
`pgNumStart`, so a missing `w:pgSz` produces no key at all (never
`pageSize: undefined`).

### 4. Orchestrator and pipeline: a sibling field, never nested

`HeaderFooterCaptureResult.pageSize?: PageSize`
(`src/parser/docx/header-footer.ts`) sits alongside `composition`/`warnings`
as its own field — NOT nested inside `composition` or `raw` — because every
DOCX document has a page size (unlike the occasional `pgNumStart`), so it
isn't "header/footer content" in the sense the rest of that result models.
`src/parser/docx/index.ts`'s final `SpecTree`-assembly spread pulls
`hf.pageSize` independently of the `headerFooter`/`hiddenTables` conditionals:
a document can carry `w:pgSz` with zero header/footer content at all.

### 5. Generator: `page.size` becomes unconditional, defaulting via a small dedicated module

`src/generator/page-size.ts` (new, kept separate from `generator/index.ts` to
minimize diff there for sibling in-flight work) exports:

- `LETTER_PAGE_SIZE: PageSize = { width: 12240, height: 15840, orientation: 'portrait' }`
- `resolvePageSize(pageSize: PageSize | undefined): PageSize` — pure, total,
  `pageSize ?? LETTER_PAGE_SIZE`.

`sectionHeaderFooterOptions`'s `properties.page` — previously present only
conditionally — is now **always** present with `size: PageSize`. This was
confirmed safe by the spike: 36/36 generator unit tests plus the full
125/125 across `manual`/`header-footer`/`index` test files passed unchanged
when this went from conditional to unconditional, meaning no existing caller
relied on `page` being absent.

Call sites: `generateDocx` passes `resolvePageSize(tree.pageSize)`;
`generateManual`'s per-tree section does the same per source tree; its
front-matter section (no single source tree) uses
`resolvePageSize(trees[0]?.pageSize)` — explicitly the first tree's captured
size, not the pre-existing `firstRender` variable, since a manual's front
matter has no rendered content of its own to derive a page size from.

### 6. `exactOptionalPropertyTypes` gotcha: forward `orientation` via conditional spread, never direct assignment

The local page-size object `sectionHeaderFooterOptions` builds must forward
`pageSize.orientation` (typed `'portrait' | 'landscape' | undefined`) into a
field declared `orientation?: T` under this repo's `exactOptionalPropertyTypes:
true`. A direct `{ ...base, orientation: pageSize.orientation }` assignment
fails `tsc` (TS2375) — the source type explicitly includes `undefined`, which
is not assignable to an optional key. The fix is this codebase's existing
conditional-spread idiom:
`{ width, height, ...(pageSize.orientation !== undefined ? { orientation: pageSize.orientation } : {}) }`.

## Consequences

- A regenerated DOCX now carries the source document's own page dimensions
  and orientation when captured, instead of always defaulting to Letter
  portrait — closing a fidelity gap that previously affected any
  non-Letter-sized or landscape-oriented source.
- `paragraphs`/`specs` persistence is unaffected: `pageSize` lives in the
  existing `SpecTree` JSONB payload governed by `SpecTreeSchema` — additive,
  backward-compatible, no migration.
- No behavior change for a `.SEC` source, or any DOCX whose trailing
  `w:sectPr` lacks a `w:pgSz` (or carries a zero/negative/non-finite
  dimension): `pageSize` stays absent and the generator's existing Letter
  default applies exactly as before this change.
- `src/parser/docx/index.ts` and `src/parser/docx/header-footer.ts` needed no
  extraction before this landed — both are lint-clean under the repo's
  400-line cap (`skipBlankLines`/`skipComments` semantics) both before and
  after the addition; a pre-spike design assumption that an extraction was a
  prerequisite here was wrong and is explicitly retracted by this ADR.
