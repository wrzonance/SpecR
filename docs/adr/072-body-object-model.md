# ADR-072: DOCX body object model (tables, text boxes)

## Status

Accepted

## Context

\#300 closes a long-standing gap the 5-signal inference engine was never
designed to cover: a body-level `w:tbl` (table) or `w:drawing`/`w:pict` text
box sitting between ordinary paragraphs in `word/document.xml`. Before this
work, `tables.ts`'s `extractTables` (#293) only *counted* visible top-level
tables and surfaced a `table-content-skipped` warning — the table's own
content was never captured, never rendered, and never round-tripped. A real
submittal-matrix table, an acceptable-manufacturers grid, or a specifier's
sidebar text box simply vanished from the parsed spec tree.

The 5-signal engine (numbering.xml, style chains, document order, text
pattern, indentation) infers CSI outline position — PART → Article →
pr1…pr7 — from a *flat sequence of paragraphs*. A table cell's content has
no CSI outline position at all: "row 3, column 2" is not a PART or an
Article, and forcing it through the same classifier that places "1.2
REFERENCES" would be a category error, not a missing feature. This ADR's
central decision is therefore to model body objects as a **second, parallel
capture pass** that never touches the 5-signal pipeline, rather than
extending the classifier to understand table/text-box interiors.

A pre-implementation spike (per this repo's design-first loop) built the
capture pipeline against nine real corpus fixtures — including a
submittal-matrix table with two of its three table hosts landing on *empty
spacer paragraphs* the paragraph-tier content filter drops before ever
reaching the tree-assembly stack — before the design below was finalized.
The spike found the original design mostly sound but forced several
simplifications recorded as addenda at the end of this document (decisions
12–16): a struct (`HostedBodyObject`) and a field (`DocxParagraph.bodyOrdinal`)
were dropped entirely once the spike proved they were unnecessary, and the
`buildTree` attachment mechanism needed a different trigger than first
designed.

## Decision

### 1. Objects round-trip as an opaque OOXML blob — never modeled CSI structure

A captured table or text box's own markup (`ObjectMeta.blob`, an array of
`ObjectBlobNode`) is a JSON-safety-only mirror of ONE
`fast-xml-parser` `preserveOrder: true` node tree, byte-reserializable via
`createOrderedDocumentXmlBuilder()`. SpecR never interprets a cell's or a
text box's interior as PART/Article/pr-tier structure — it is captured,
stored, and rendered as-is. This mirrors the existing posture for hidden
tables (ADR-038) and unmodeled header/footer content (ADR-068's
`raw.unmodeled`): round-trip fidelity over forced interpretation whenever
a body region falls outside the CSI outline model.

### 2. New node types `object` / `objectText`, never counted by CSI numbering

`object` (the table/text-box container, `meta.editability: 'locked'`) and
`objectText` (one interior paragraph's extracted text, a direct child of
`object`) join the existing `NodeType` union. Both are excluded from
`consumesNumber` (`src/ast/labels.ts`) — an `object` at a PART's root level
never shifts sibling PART numbering, and `renderChildren`'s ordinal walk
(`generator/markdown.ts`) skips both the same way it already skips
`note`/`continuation`. `auditTreeStructure`'s junk-root filter (`inference.ts`)
excludes `type === 'object'` the same way it already excludes `'part'` — a
table sitting before a document's first PART heading is real, modeled
content, never unclassified preamble junk.

### 3. `object.meta.object.blob`'s interior paragraphs get the SAME `w:sdt` merge anchor as ordinary body paragraphs

Every interior paragraph inside a captured blob (a table cell's paragraph, a
text box's `txbxContent` paragraph) is wrapped by
`object-anchor.ts`'s `wrapBlobParagraphWithAnchor` in the identical
`w:sdt > w:sdtPr > w:tag[w:val="specr-uuid-<uuid>"]` shape
`generator/controls.ts`'s `SdtBlock` already produces for every other body
paragraph (ADR-004). The UUID baked into the anchor is the **sole** locator
for that paragraph inside the blob — there is no separate `blobPath`/index
field anywhere in the AST. `objectText` carries only `{ id, text }`,
mirroring `controls.ts`'s own paragraph-UUID convention exactly, so a
merge/edit operation finds the paragraph back inside the blob the same way
`merge/extract.ts`'s `readUuidFromSdtPr` already finds any other body
paragraph. The spike found no desync risk in this single-locator design
across nine corpus fixtures.

### 4. Floating placement ("before the first paragraph") is a plain `undefined` index, never a sentinel type

A table or drawing that sits before the document's first paragraph has no
"preceding paragraph" to key off. The design considered a dedicated
`HostedBodyObject` wrapper type with a `'before-first'` sentinel enum value;
the spike found this unnecessary — `buildTree`'s own `roots` array is
already the correct attachment point *by construction* at the start of tree
assembly (nothing has been pushed to the stack yet), so
`precedingParagraphIndex: number | undefined` on `BodyOrderTable`, with
`undefined` meaning "prepend to roots," is the whole mechanism. No sentinel
type was introduced (see addendum, decision 15).

### 5. A table's visibility split (ADR-038) is untouched and independent of object capture

`classifyTopLevelTables` (promoted out of `tables.ts`'s `extractTables` as a
zero-behavior-change extraction, regression-tested byte-identical against
existing fixtures first) still splits hidden vs. visible tables exactly as
ADR-038 established. Body-object capture (`body-objects.ts`) reuses that
same classification to skip hidden tables entirely — a hidden table is
still retained under `tree.hiddenTables` (never as an `object` node) and the
legacy `table-content-skipped` warning still fires once per parse for
whatever visible tables exist, **in addition to** the new `object` nodes now
modeling their content. This is intentionally un-deduped: the two warning
sources answer different questions ("a table exists" vs. "this table's
content is now modeled") and merging them into one conditional would only
make a future reader wonder why a `table-content-skipped` warning can now
coexist with fully-modeled table content.

### 6. Text boxes are recognized by their `wps:txbx` child, never by shape/autoshape heuristics

`body-drawings.ts`'s `classifyBodyDrawing` recognizes a text box by the
presence of a `wps:wsp` graphicData node carrying a `wps:txbx` child
(DrawingML) or a `v:shape` carrying `v:textbox` (VML) — never by inferring
"this looks like a text box" from size/position. An ordinary autoshape
(`wps:wsp` with no `wps:txbx`) correctly falls through to `{ kind:
'unknown' }` and is dropped with a warning, not miscaptured as an empty
text box.

### 7. `mc:AlternateContent` always keeps the `mc:Choice` branch, discards `mc:Fallback`

Word wraps a modern DrawingML text box in
`<mc:AlternateContent><mc:Choice Requires="…">…</mc:Choice><mc:Fallback>
…</mc:Fallback></mc:AlternateContent>` so older readers fall back to an
equivalent VML rendering. `unwrapAlternateContent` always keeps `mc:Choice`
and discards `mc:Fallback` — re-emitting both would let an interior text
edit diverge from a stale VML fallback after a round-trip. A VML-only
source (no `AlternateContent` wrapper at all) is unaffected: it has nothing
to unwrap and is classified on its own `w:pict` content directly.

### 8. Floating vs. inline is presence-only (`wp:anchor` vs. `wp:inline` / VML `position:absolute`) — never true visual position

`floating` records only whether the drawing is anchored (`wp:anchor`) or
inline (`wp:inline`), or (VML) whether the shape's own `style` attribute
contains `position:absolute`. This is a KNOWN AMBIGUITY: a floating
object's true visual position can diverge arbitrarily from its host
paragraph (that is the entire point of "floating"), and SpecR records only
where the drawing's *run* sits in document order — never attempting to
resolve or approximate on-page geometry. Pinned as a test in
`body-drawings.test.ts` rather than silently guessed at.

### 9. Every other body-level drawing species is DROPPED with a `body-drawing-skipped` warning — never silently lost

A chart, smartArt diagram, OLE object, image, or any unrecognized drawing
species at body level is intentionally out of scope for #300 (images follow
up in #511) but is never silently discarded. `body-objects.ts` collects
every dropped drawable and `index.ts` assembles exactly one aggregate
`body-drawing-skipped` `ParseWarning` per parse (gated on
`dropped.length > 0`), with a per-kind count in its `suggestion` string —
the same no-silent-loss posture ADR-068 already established for unmodeled
header/footer content.

The same no-silent-loss/no-silent-duplication posture extends to WS2's own
capture-path fix for #517: a text box's `mc:AlternateContent` wrapper must
be normalized to its `mc:Choice` branch in the *captured blob* the same way
decision 7 already normalizes it for *classification* — see addendum 19 for
the full account and `parser/docx/alternate-content.ts`.

### 10. `buildTree` attaches objects by paragraph index, using the SAME primitive `appendContinuation` already uses for suppressed content

`buildTree` now takes two additional params: `objectsBeforeFirst` (prepended
to `roots`, decision 4) and `objectsByPrecedingIndex` (a
`ReadonlyMap<number, readonly SpecNode[]>` keyed by the classified
paragraph's index in the ORIGINAL, unfiltered `classified` array). The main
loop now iterates **every** classified paragraph unfiltered by index —
not the content-filtered subset the pre-#300 loop iterated — because two of
three real table hosts in the spike's proof fixture are empty spacer
paragraphs the content filter drops before the stack-push loop ever sees
them. After processing paragraph `i` (whether it was pushed to the stack,
filtered as empty, or suppressed as a delimiter), any objects keyed at index
`i` are appended to `lastNonContChildren` — the exact attachment point
`appendContinuation` already writes to for suppressed content. No new
attach primitive was introduced; this is the same "children of whatever
structural node most recently opened" rule, applied to one more kind of
trailing content.

### 11. `classifyParagraphs` (the 5-signal engine itself) needed NO change

The 5-signal engine never sees table-interior or text-box-interior content
in the first place: `document.ts`'s grouped-mode parse (`body['w:p']`)
structurally excludes any `w:p` nested inside a `w:tbl` cell or a drawing's
`txbxContent` — same-tag grouping only merges *sibling* `w:p` elements
directly under `w:body`, never ones nested inside another element. This was
originally an open question at design time (could a table's interior
paragraph accidentally get double-classified by the paragraph walk?); the
spike confirmed empirically, across the full corpus, that the answer is no
by construction — the exclusion is free, and no runtime guard was added
anywhere in `classifyParagraphs` or `inference.ts`'s signal-scoring.

### 12. Cross-tag document order is recovered by a SEPARATE `preserveOrder` walk, not threaded through `DocxParagraph`

Knowing "does this table sit before or after paragraph index 4" requires
walking `w:body`'s direct children in true document order — information
`document.ts`'s grouped-mode parse (tag-grouped, not document-ordered)
cannot answer. `body-order.ts`'s `computeBodyOrder` performs one independent
`preserveOrder: true` parse of the same `word/document.xml` and returns
`{ tables, paragraphBlobs }`: `paragraphBlobs[i]` is *index-aligned* with
`document.ts`'s own `body['w:p']` array order — pinned as an invariant,
tested against a real multi-table fixture — so a caller that already parsed
the document via `document.ts` can pair a paragraph's classified index
straight into this array with zero second lookup. This mirrors the
established `preserveOrder`-pairing technique already used by
`merge/extract.ts`, `source-facts.ts`, and `header-footer-run-order.ts` for
the exact same class of "grouped-mode parsing lost my cross-tag ordering"
problem.

### 13. Table dimensions: `w:tblGrid`/`w:gridCol` first, max per-row cell count as fallback

`tableDimensions` derives `rows` from the `w:tr` count and `columns` from
`w:tblGrid`'s `w:gridCol` count when present, falling back to the maximum
per-row `w:tc` count otherwise (a table missing an explicit grid
declaration — rare, but not disallowed by the schema). `object.children.length
=== rows * columns` (`markdown.ts`'s `isSimpleGrid`) is the generator's own
signal that the captured cell count cleanly maps to a rectangular grid with
no merged or blank cells to account for; a mismatch falls back to a labeled
one-line-per-cell rendering rather than guessing at cell positions
(decision 14).

### 14. The renderer never guesses at merged-cell layout — a mismatch degrades to a labeled fallback, never a wrong-shaped table

`generator/markdown.ts`'s `renderObjectNode` renders a table as a real GFM
pipe table only when `isSimpleGrid` holds (decision 13). Any other case —
merged cells, a blank cell (never captured as its own `objectText` leaf,
since an empty-text interior paragraph produces no leaf at all — decision
16), or an `object` node missing its `meta.object` entirely — renders via
`renderObjectFallback`: a `> **[TABLE]**` or `> **[OBJECT]**` label
followed by one indented line per captured interior text, in document
order. A text box always renders as `> **[TEXT BOX]** <joined interior
text>`, with a `*(floating)*` suffix when `floating` is true. Table/text-box
content is captured and rendered **verbatim** — this is a deliberate
consequence of decision 1 (opaque, uninterpreted blob), not an oversight:
suppressing or reinterpreting *any* cell content (e.g. an asterisk-rule
decoration row a spec author used purely as in-cell visual separation)
would mean selectively editing locked content, the opposite of this ADR's
no-silent-loss posture. See `markdown.test.ts`'s dedicated pins for both the
simple-grid and fallback paths, and
`note-region-corpus.integration.test.ts`'s corpus-level pin distinguishing
paragraph-tier note suppression (still active, untouched by #300) from
object-tier verbatim rendering (new, and expected to differ).

## Corpus-validation addenda (spike- and full-corpus-run findings)

### 15. `suppressEmptyNode: true` is load-bearing for byte-identical round-trip

`createOrderedDocumentXmlBuilder` (the `XMLBuilder` half of the
`createOrderedDocumentXmlParser`/`createOrderedDocumentXmlBuilder` pair,
`xml-utils.ts`) sets `suppressEmptyNode: true`. Without it, a self-closing
empty OOXML element (e.g. `<w:tcW w:w="1440" w:type="dxa"/>`) parses to a
node with an empty children array and re-serializes as an explicit
open/close pair (`<w:tcW …></w:tcW>`) — semantically identical to any real
DOCX consumer, but not the same bytes. The spike measured an 18335→21005
character drift on a real table fixture with this flag omitted; it is
pinned as a negative-control test in `xml-utils.test.ts`.

### 16. SUPERSEDED — the WS2 (generator re-emit) bridge is DIRECT CONSTRUCTION, never a raw-string round trip

*Original (#300) text, superseded by WS2 (#517) below: "A future generator
task that re-emits a captured blob back into a real `docx` document needs
`ImportedXmlComponent.fromXmlString`, which takes a raw XML string — not an
`ObjectBlobNode` tree. The bridge is therefore a two-step reserialize:
`createOrderedDocumentXmlBuilder().build(blob)` to a string, THEN
`fromXmlString`."*

WS2 built and ran three throwaway scripts against a real `Packer` round trip
before writing any production code, and found the two-step reserialize above
does not work: `ImportedXmlComponent.fromXmlString` re-parses its input as a
**standalone XML document** and, verified against the pinned `docx@9.7.1`
dependency actually installed in this repo (not assumed from memory),
double-wraps the blob's own root element — a re-serialized `w:tbl` comes
back out as `<w:tbl><w:tbl>…</w:tbl></w:tbl>`. Re-parsing a string that was
itself just reserialized from an already-parsed tree throws away the exact
structural information the bridge needs to preserve.

The actual bridge (`generator/object-block.ts`) never touches an XML string
at all: `buildImportedXmlComponent` walks the captured `ObjectBlobNode` tree
directly and builds `ImportedXmlComponent` nodes via its **constructor +
`push`** — the same tree-shape, node-by-node construction `docx` itself uses
internally, just driven from `ObjectBlobNode` data instead of from calls to
`docx`'s own builder API. `ImportedObjectBlock` (a thin `FileChild`) wraps
the single resulting root component so it can sit in a `Document` section's
`children` array beside `Paragraph`/`SdtBlock`. `buildObjectBlocks` fails
loud — `GeneratorError` — on a blob with `!== 1` root node (never valid per
`ObjectMetaSchema.blob`'s own invariant) and wraps any deeper build failure
with the object's own node id as context.

### 17. `UUID_TAG_PREFIX` relocated to `src/ast/uuid-tag.ts` — the single source of truth

Before #300, `UUID_TAG_PREFIX` (`'specr-uuid-'`, the `w:sdt` merge-anchor
tag prefix, ADR-004) had already drifted into two independent
module-private literal copies: `generator/controls.ts` (which writes the
tag) and `merge/extract.ts` (which reads it back). `object-anchor.ts` would
have been a third copy — module-boundary rules mean neither `generator/`
nor `merge/` can import from the other, and `parser/` cannot import from
either. The fix: relocate the constant to `src/ast/uuid-tag.ts` (the
foundational, dependency-free `ast/` layer every other module may import
from) and update all three sites — `controls.ts`, `extract.ts`, and the new
`object-anchor.ts` — to import the shared constant. A regression test pins
that `object-anchor.ts`'s anchor and `controls.ts`'s `SdtBlock` tag an
identical `uuid` with the identical `w:tag` value. This is a small,
DRY-justified fix (3 occurrences meets this repo's code.md extraction
threshold) to a pre-existing duplication, not new scope invented by #300.

### 18. Decision 11 (5-signal exclusion) is satisfied for free by grouped-mode parsing — confirmed empirically, not by a runtime guard

Restated from decision 11 for visibility here: this was the single largest
open question the spike was run to answer, and the full-corpus validation
(`pnpm fixture:snapshot`/`fixture:diff` across all 666 UFGS `.SEC` files —
unaffected, DOCX-only feature — plus the full gitignored DOCX corpus)
confirms no paragraph anywhere in the corpus was double-classified by both
the 5-signal engine and the body-object capture pass. No guard was added
because none was needed.

### 19. WS2 (#517): `mc:AlternateContent` must be normalized in the captured BLOB, not just at classification time

Decision 7 established that `body-drawings.ts`'s `unwrapAlternateContent`
always keeps a drawing's `mc:Choice` branch and discards `mc:Fallback` — but
that function operates on ONE grouped-mode node, purely to decide *what kind*
of drawing a run carries. It was never meant to (and does not) touch the
separately-parsed `ObjectBlobNode` blob `body-order.ts` hands to
`buildTextBoxObject` for capture. Before WS2's generator re-emit made this
observable, that gap was silent: the blob still round-tripped byte-identical
(decision 1), it just carried BOTH the `mc:Choice` and the stale
`mc:Fallback` (VML) branch side by side, unnormalized.

WS2 surfaced the consequence: `anchorInteriorParagraphs`'s depth-agnostic
`w:p` walk (`body-objects.ts`) finds interior paragraphs in *both* branches
of an un-normalized `mc:AlternateContent`, so a captured text box's
`interiorTexts` silently doubled, and an edit to the live (DrawingML)
paragraph would visibly diverge from a VML fallback nobody edited on the
next round trip. `parser/docx/alternate-content.ts`'s
`stripAlternateContentFallback` closes this: a pure, total, recursive
`preserveOrder`-mode normalizer that replaces every `mc:AlternateContent`
descendant of a blob root with its `mc:Choice` child's children (discarding
`mc:Fallback`), called from `buildTextBoxObject` immediately before
`anchorInteriorParagraphs`. It is deliberately a SEPARATE module from
`unwrapAlternateContent` rather than a shared extraction: different node
shape (`preserveOrder` vs. grouped-mode), different scope (normalize an
entire subtree vs. classify one run), and a different transformation
(splice `mc:Choice`'s children into the parent's array in place of the
`mc:AlternateContent` node vs. substitute one node for another). Multiple
`mc:Choice` siblings inside one `mc:AlternateContent` is a KNOWN AMBIGUITY
carried over from decision 7's own caveat: OOXML permits it, no known fixture
exercises it, and the first `mc:Choice` wins.

### 20. KNOWN AMBIGUITY (WS3-scoped): a nested table/text-box inside a captured object's blob is double-anchored but never independently addressable

`body-objects.ts`'s `transformChildren`/`transformInteriorParagraphs` walk
(decision 3's anchoring pass) recurses into every non-`w:p` child
unconditionally — it does not stop, or change behavior, at the boundary of a
SECOND `w:tbl` or text box nested inside the outer object's own blob (e.g. a
table cell containing its own nested table, or a text box whose interior
holds another drawing). That nested artifact's own interior paragraphs get
the identical `w:sdt` merge anchor (`wrapBlobParagraphWithAnchor`) as the
outer object's own direct interior paragraphs — the anchoring pass has no
signal that distinguishes "this anchored paragraph is a direct cell of the
object I'm capturing" from "this anchored paragraph belongs to a table or
text box nested N levels inside that object." WS1/WS2 only ever promote a
BODY-level table/text-box (one whose host sits as a direct, document-ordered
member of `w:body`) to its own top-level `object` SpecNode; a nested one is
never separately promoted — its anchored paragraphs surface only as
`objectText` leaves of the OUTER object, with no independent id, no
independent editability, and no way for a caller to address "the nested
table" as its own unit.

This is provisionally harmless for WS2's own scope — decision 1's opaque,
verbatim-blob posture means the nested artifact still round-trips
byte-identical either way, anchored or not — but it leaves two open
questions explicitly deferred to WS3: (1) whether a nested table/text-box
should be promoted to its own `object` SpecNode nested inside its parent's
`objectText` children, and (2) if a future merge/edit operation ever needs
to walk a captured blob's OWN `w:sdt` anchors (rather than only the flat,
one-level-deep body walk `merge/extract.ts`'s `readUuidFromSdtPr` performs
today), how it would disambiguate an anchor nested inside one structural
container from one nested inside two. `body-objects.test.ts`'s "KNOWN
AMBIGUITY: nested table/text box" suite now pins today's flattening behavior
(a nested table's interior text lands in the OUTER object's `interiorTexts`,
never promoted to its own `object`); this addendum documents the two open WS3
promotion/disambiguation questions above so the gap is a reviewed decision
rather than discovered by surprise.

## Consequences

- A captured table or text box's content is now visible in the parsed spec
  tree and rendered output for the first time — previously it was either
  silently absent (text boxes: not modeled at all) or counted-but-unrendered
  (visible tables: `table-content-skipped` only). This is a strict fidelity
  improvement, but it is also a **visible behavior change**: any consumer
  (test, downstream fixture comparison, a spec editor's expectation) that
  previously assumed "table content never renders" will now see that
  content appear verbatim, asterisk-rule decoration and all (decision 14).
  `note-region-corpus.integration.test.ts` needed exactly this update during
  #300's own corpus-validation pass — a real submittal-matrix table in the
  `hidden-text-test.docx` corpus fixture surfaced this expected change, and
  the test now pins BOTH halves explicitly: paragraph-tier note suppression
  is unaffected, object-tier content renders verbatim by design.
- `object`/`objectText` join the `NodeType` union as the 13th/14th values
  across every enum site that enumerates node types (`openapi.yaml`,
  `ast/types.ts`, `ast/labels.ts`) — a mechanically larger diff than a
  single new node type usually implies, tracked and accepted as
  `openapi.yaml`'s per-repo LOC-check carve-out already covers.
- `paragraphs.object_data` (migration 047) is additive, nullable, no
  default — every pre-#300 row and every non-`object` row is `NULL` — the
  same posture as `signal_provenance` (migration 041) and every other
  hybrid-validation JSONB column in this schema (ADR-021).
- Images inside body-level tables/text boxes, and body-level images outside
  any table/text-box (a bare `w:drawing` paragraph classified `{ kind:
  'image' }` by `body-drawings.ts`), remain out of scope — tracked as the
  explicit #511 follow-up, not silently deferred.
- `UUID_TAG_PREFIX`'s relocation (decision 17) is a small, backward-compatible
  refactor of two pre-existing call sites; both continue to tag identically,
  pinned by regression test.
- **The generator round-trip gap is now CLOSED (WS2, #517).** At #300/WS1
  time, an `object`/`objectText` node's captured blob had no generator-side
  counterpart at all: a DOCX regenerated (`POST /specs/{id}/generate`) from a
  spec tree containing captured tables/text boxes would have silently
  dropped that content — the exact gap addendum 16 originally flagged as a
  "future generator task." WS2 closes it: `generator/index.ts`'s `emitNode`
  re-emits every `object` node's blob byte-faithfully via
  `object-block.ts`'s `ImportedObjectBlock`/`buildObjectBlocks` (addendum 16,
  superseded), and `body-object-round-trip.test.ts` proves the closed loop —
  parse → generate → re-parse — conserves object kind/generation/floating
  and every interior text, for both tables and DrawingML/VML text boxes.
  Discovering this path also surfaced a second, previously-silent gap in the
  capture side itself (an un-normalized `mc:AlternateContent` in a captured
  text box's blob), fixed by `alternate-content.ts` and tracked as its own
  issue, #517 (addendum 19). A nested table/text-box's own promotion and
  merge-anchor story remains open, deferred to WS3 (addendum 20).
