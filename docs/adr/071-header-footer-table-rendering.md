# ADR-071: header/footer table-grid rendering

## Status

Accepted

## Context

\#301 (the header/footer fidelity umbrella) has shipped the v2
composition schema (ADR-040, #302), the capture pipeline (ADR-068,
#306), text/field rendering (#303), and image/logo rendering (ADR-069,
#308). #309 is the remaining renderer slice explicitly deferred by all
of those: many real specification footers are laid out as a simple
table/grid ("Drawing No. | Sheet 1 of 3 | Approved by:" in three
bordered columns), and flattening that to tab-separated text loses
page-level fidelity. #309's scope is deliberately narrow — simple
table/grid layouts only, split out from #300 (the broader
parser/generator table-fidelity concern for the CSI AST body) so the
text/field renderer this ADR's predecessors built stays small.

A pre-implementation spike (per this repo's design-first loop) built
six synthetic fixtures against the design below before any real
implementation and found the shapes and helper functions sound as
designed, with two corrections: a line-count verification method fix
(this ADR, decision 6) and a required decomposition in a later task's
generator aggregator (`collectTableWarnings`, decision 7) to satisfy
this repo's enforced `complexity: 10` ESLint rule. Neither changes any
schema shape recorded here.

This ADR (like ADR-069 before it) records the whole feature's design
in one place even though the implementation lands across several
tasks — this document is Task 1's deliverable: a purely additive AST
schema extension with no consumers yet. Tasks 2-6 (parser capture,
generator rendering, `openapi.yaml`) build against the shapes fixed
here.

## Decision

### 1. `region.table` is a new sibling slot, not a replacement for the paragraph model

`HeaderFooterRegionSchema` (ADR-040) already models one `{ left,
center, right }` row per header/footer part. A table grid is a
qualitatively different shape (rows × cells, not three tab-stopped
cells), so it is added as a new, independent, optional slot —
`table: HeaderFooterTableSchema.exactOptional()` — alongside
`left`/`center`/`right`/`style`/`ruleLine`, rather than replacing or
overloading the cell model. A single region can carry **both** a
paragraph and a table (a caption line above a grid, for example): the
generator renders whichever are present, paragraph first, in document
order — mirroring how #308 added `kind: 'image'` as a new field kind
rather than a parallel node type, but here the table's structure is
genuinely different from a cell row, so a sibling slot (not a field
kind) is the right shape.

### 2. Simple-table scope reuses three existing schemas verbatim — no parallel type system

A table cell's `content` is `z.array(HeaderFooterFieldSchema)` — the
same open, 13-kind (incl. `image`) field schema every other
content-bearing slot in this file already uses. A cell's `style` is
the same `HeaderFooterVisualStyleSchema`. A table's `borders` is the
same `HeaderFooterRuleLineSchema` ADR-040 already defined for
`region.ruleLine`, applied uniformly to all six `ITableBordersOptions`
edges (`top`/`bottom`/`left`/`right`/`insideHorizontal`/
`insideVertical`) via the generator's existing `ruleLineBorder()`
helper — the spike confirmed this round-trips through `docx`'s
`Packer` as a real `<w:tblBorders>` element with all six children
present in the packed XML. Reusing these three schemas instead of
inventing table-specific variants keeps the "known keys typed, unknown
keys open" posture (ADR-021) uniform across every header/footer slot,
and means a future field kind or style property added to the shared
schemas is automatically available inside table cells with zero
additional schema work.

```typescript
const HeaderFooterTableCellSchema = z
  .object({
    content: z.array(HeaderFooterFieldSchema).exactOptional(),
    columnSpan: z.number().int().positive().exactOptional(),
    separator: z.string().exactOptional(),
    style: HeaderFooterVisualStyleSchema.exactOptional(),
  })
  .catchall(JsonValue);

const HeaderFooterTableRowSchema = z
  .object({ cells: z.array(HeaderFooterTableCellSchema) })
  .catchall(JsonValue);

const HeaderFooterTableSchema = z
  .object({
    rows: z.array(HeaderFooterTableRowSchema).min(1),
    columnWidths: z.array(z.number().int().positive()).exactOptional(),
    borders: HeaderFooterRuleLineSchema.exactOptional(),
  })
  .catchall(JsonValue);
```

`rows` requires at least one row (`min(1)`) — a table with zero rows is
not a table; the schema rejects that fabricated shape rather than
accepting it and pushing the problem downstream to the generator.

### 3. Images are excluded from table cells structurally, not by a second field schema

#309's scope explicitly keeps "image/table intersections... out unless
already handled by the image/logo slice" (#308). Rather than defining
a second, image-less field schema for table-cell content — which would
duplicate `HeaderFooterFieldSchema` and immediately drift from it —
`HeaderFooterTableCellSchema.content` reuses the full 13-kind field
schema unchanged. The "no images in table cells" rule is enforced at
**render time** in the generator (a `TextRun`-only render path for
table cells, plus an explicit warning when an `image`-kind field is
found inside `content`), not by the type system. This mirrors ADR-069's
own trust-boundary posture (`imageMediaType` is round-tripped as open
data but never trusted by the renderer): the schema stays uniform and
permissive: everywhere a field can be authored, all thirteen kinds are
structurally valid) and the actual behavioral restriction lives in
code, where it can produce a helpful warning (ADR-068/069's "preserved
or warned, never silently dropped" posture) instead of a hard parse
rejection that would make an otherwise-valid captured document fail to
round-trip.

### 4. A malformed table structurally disqualifies the whole table; a malformed field disqualifies only itself

Two different unsupported-content failure modes get two different
granularities, matching the structural reality of each:

- **Nested tables and vertical/horizontal cell merges** (`w:tbl`
  nested inside a `w:tc`, or `vMerge`/`gridSpan` beyond simple
  `columnSpan`) disqualify the **entire table** — it is captured whole
  into `raw.unmodeled { kind: 'table' }` with one warning, not
  partially rendered. A table's row/column structure is only correct
  as a unit; rendering a merge-bearing grid as if it were a simple
  rectangular one would silently corrupt the layout rather than
  preserve it.
- **An unsupported field or an extra paragraph** inside an otherwise
  simple, capturable table follows the same per-item granularity
  ADR-068 already established for paragraph capture ("first paragraph
  wins", extra paragraphs become `unmodeled { kind: 'extraParagraph'
  }`): only the offending field or paragraph is dropped-and-warned,
  the surrounding table structure is preserved.

### 5. "First table wins", mirroring "first paragraph wins" (ADR-068)

A header/footer part's root-level children can in principle contain
more than one `w:tbl` (table detection is a structural fact per
ADR-068 — a `w:tbl` is a root-level sibling of `w:p`, never nested
inside one). Consistent with ADR-068's existing "at most one captured
paragraph per part" rule, this capture keeps only the **first**
qualifying (non-nested, non-merged) `w:tbl` as `region.table`; any
subsequent table in the same part is captured whole into
`raw.unmodeled { kind: 'table' }` with its own warning, never merged
into or overwriting the first.

### 6. Line-cap verification uses the enforced ESLint rule, not raw `wc -l`

The pre-spike task design worried that extracting shared capture
helpers (`captureBorderEdge`, generalized out of the existing
`captureRuleLine`) would push `header-footer-region.ts` over this
repo's 400-line cap, based on a raw `wc -l` count (415 lines
post-extraction). The spike found this the wrong metric: this repo's
actual enforced `max-lines` ESLint rule (`eslint.config.js`,
`CLAUDE.md` "ESLint is enforced, not advisory") is configured with
`skipBlankLines: true, skipComments: true`, and `npx eslint
src/parser/docx/header-footer-region.ts` reports zero errors against
the post-extraction file. Future line-budget checks in this repo
should default to the enforced-rule check (`npx eslint <file>`) as the
source of truth, not a raw line count that includes blank lines and
comments the rule itself excludes.

### 7. `collectTableWarnings` requires a pre-resolving helper from the start

A later task's generator aggregator that walks all six
header/footer-variant slots (`default`/`first`/`even` ×
`header`/`footer`) to collect table warnings reads a **doubly**-nested
optional field (`variant?.header?.table`, vs. ADR-069's
`imageFieldWarnings` precedent which only ever read a
**singly**-nested `variant?.header`). Written as a naive 6-line
aggregator mirroring `collectImageWarnings`'s shape, this measures
ESLint `complexity: 11` against the enforced cap of 10 — a trap
specific to the extra level of optional chaining, not something
ADR-069's precedent encountered. The fix, required from the start
rather than an optional refactor-if-flagged item: a small
`regionTable(variant, key)` helper pre-resolves `variant?.[key]?.table`
in one place, so the aggregator itself calls it six times with zero
optional-chain operators of its own (pure function calls do not count
toward cyclomatic complexity).

## Consequences

- Acceptance criteria are set up to be met by construction once Tasks
  2-6 land: a table-based footer fixture captures into `region.table`
  and renders as a real `docx.Table` (criterion 1); nested tables,
  merged cells, unsupported fields, and extra paragraphs each produce
  a warning without ever throwing or dropping the surrounding
  region's other content (criterion 2); existing text/field/image
  header/footer rendering (`FIELD_RESOLVERS`, `renderFieldRun`,
  `renderImageRun`) is untouched by this schema addition — `table` is
  a new, independent, optional slot (criterion 3).
- `HeaderFooterTableCellSchema`/`HeaderFooterTableRowSchema`/
  `HeaderFooterTableSchema` (this ADR) join
  `HeaderFooterFieldSchema`/`HeaderFooterVisualStyleSchema`/
  `HeaderFooterRuleLineSchema` (ADR-040) as the full set of reusable
  content-shape building blocks for header/footer composition — no
  new field-schema variant was introduced for table cells (decision
  2/3 above).
- This task (Task 1/6) is schema-only: additive, backward compatible
  (every pre-#309 `HeaderFooterRegion` value — with or without
  `table` — continues to parse unchanged), and has no consumers yet.
  No DB migration (JSONB, same posture as ADR-040/068/069).
  `openapi.yaml`'s `&headerFooterTable` anchor/alias addition (mirroring
  the pre-existing `&headerFooterRuleLine` pattern at
  `openapi.yaml:8631+`) and the parser/generator implementation are
  separate, already-scoped follow-up tasks in this same issue.
- Out of scope, unchanged from #301/#308/#309's own stated boundaries:
  the broader CSI-AST-body table-fidelity concern (#300), resolving
  header/footer content across the client → project → package →
  revision scope chain (#304), and any visual-fidelity round-trip
  verification beyond what a render-only slice can assert on its own
  (tracked against #150/#305).
