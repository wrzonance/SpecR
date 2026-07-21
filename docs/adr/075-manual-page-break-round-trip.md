# ADR-075: Manual page-break round-trip

## Status: Accepted

Builds on ADR-022 (persistent source facts) and ADR-072 (body object model, which
already preserves interior `w:br` verbatim for `object` nodes).

## Context

A spec editor inserts a manual page break in Word (`w:br w:type="page"`) to force
the next paragraph onto a new page — most commonly before a new PART or a table
that must not straddle a page. SpecR's DOCX parser previously discarded this run
entirely: it carried no text, so it vanished during round-trip and the generated
DOCX silently lost the editor's pagination intent.

The docx generation library (dolanmiu/docx) does not model a manual page break as
a run — it models it as a paragraph property, `Paragraph({ pageBreakBefore: true
})`. Source OOXML expresses the break as a `w:br` inside the *preceding*
paragraph's runs; the library's target shape puts the flag on the *following*
paragraph. Round-tripping this fact means shifting it across a paragraph boundary,
not just preserving a value in place.

Investigation of real DOCX output confirmed the run's XML shape is inconsistent
across authoring paths: `<w:br w:type="page"/>` parses to an object
(`{'@_w:type': 'page'}`), a bare self-closing `<w:br/>` (no attributes) parses to
an empty string, and two or more sibling `w:br` elements in one run parse to an
array. Any detector that assumes one shape misses the others.

## Decision

1. Capture the break on the *following* node, not the source paragraph, as
   `meta.pageBreakBefore?: boolean` (`src/ast/types.ts`) and the parser-internal
   `DocxParagraph.pageBreakBefore?: boolean` (`src/parser/docx/types.ts`). This
   matches the generator's native `Paragraph.pageBreakBefore` 1:1, so no shape
   translation is needed at the AST→DOCX boundary — only the parser's lookback
   (current paragraph inspecting its *predecessor*'s runs) performs the
   after-source → before-target shift.
2. Detect a page break by normalizing all three observed `w:br` shapes (object,
   empty string, array) through the existing `toArray` + a record guard, rather
   than assuming an object. This is a read of `run['w:br']`, already typed
   `unknown` on the run's `Record<string, unknown>` — no cast is introduced or
   required.
3. Absent is the sparse-object convention already used by `meta.vanish` and
   `sourceFacts` — `false`/no-break and "field omitted" are indistinguishable, and
   the field is only ever set to `true`.
4. `object`-typed AST nodes never carry `meta.pageBreakBefore`. Their originating
   OOXML — including any interior `w:br` — is already preserved verbatim inside
   `meta.object` (ADR-072), and the generator's object branch builds an
   `ImportedObjectBlock`, not a `Paragraph`, so there is no `pageBreakBefore`
   attachment point regardless.
5. On generate, `simpleParagraph` (the note/continuation paragraph builder,
   consolidating what were previously two byte-identical functions,
   `noteParagraph` and `plainParagraph` — see Consequences) and
   `numberedParagraph` (the structural paragraph builder) both take an optional
   trailing `pageBreakBefore` argument, forwarded from `node.meta.pageBreakBefore`,
   and spread it onto the constructed `Paragraph`'s properties only when true.
6. **Suppression-safe propagation** (`src/parser/docx/page-break.ts`,
   `resolvePageBreakBefore`, review follow-up on #497). A page break is
   captured on the raw paragraph immediately following the source `w:br` (decision
   1), but that paragraph is not guaranteed to become a SpecNode itself:
   `buildTree`'s content pre-filter (`isStructuralContent`) drops an empty/blank
   spacer paragraph and a suppressed asterisk rule-row delimiter (#292) before
   either ever reaches `makeNode`/`makeContinuationNode`. `buildTree` now carries
   a `pendingPageBreak` flag forward across every such filtered paragraph until it
   reaches the next paragraph that actually becomes a node — a break preceding
   suppressed/collapsed content is never silently dropped just because the
   paragraph it first landed on produced nothing.

### KNOWN AMBIGUITY — scope limits accepted, not solved

- **Trailing break at end-of-document.** A `w:br type="page"` in the last
  paragraph of a document has no following paragraph to attach `pageBreakBefore`
  to, and is silently dropped. There is no AST node to carry it. This also covers
  a break whose forwarding chain (decision 6) never reaches a real node before
  the document ends — same root cause, no attachment point exists.
- **Two or more breaks collapsed within one paragraph, or a break sandwiched
  between runs of the same paragraph.** These all collapse to a single boolean
  on the next node. The parser already flattens intra-paragraph run position
  ahead of this signal, so no richer positional model is available without a
  larger, out-of-scope change to paragraph-level run tracking.
- **A page break immediately preceding a body-level table/text-box** (#300,
  ADR-072). `document.ts`'s lookback (`previousParagraphHasPageBreak`) walks the
  raw `<w:p>`-only paragraph array, oblivious to an interleaved `w:tbl` — so it
  attributes the break to the paragraph *after* the captured object instead of to
  the object itself, which sits between them in real document order. Per decision
  4, an `object` node has no `pageBreakBefore` attachment point at all (its
  `ImportedObjectBlock` re-emits raw `w:tbl` XML, not a `Paragraph`), so
  `resolvePageBreakBefore` (`src/parser/docx/page-break.ts`) detects this case
  (`isPageBreakOwnedByPrecedingObject`) and drops the flag rather than
  misattaching it to the wrong paragraph. Solving this for real would mean giving
  the generator a way to force a page break ahead of a re-emitted table — a
  larger, out-of-scope change to the object-block generation path.

All three are documented here per the repo's OOXML ambiguity rule rather than
addressed by an invented behavior, and are pinned by tests marked
`// KNOWN AMBIGUITY: ...`.

## Consequences

- A manual page break placed by an editor in Word now survives a full
  parse → AST → generate round-trip as pagination-equivalent output — the
  regenerated DOCX starts the next paragraph on a new page — though not as
  byte-identical OOXML (a run becomes a paragraph property). This is a
  deliberate normalization, consistent with how SpecR already treats other
  round-trip facts that change representation without changing meaning.
- `noteParagraph` and `plainParagraph` in `src/generator/index.ts` were
  byte-identical before this change. Adding the same conditional
  `pageBreakBefore` spread to both trips `sonarjs/no-identical-functions` (the
  two single-statement functions previously sat under the rule's body-size
  threshold; the added statement pushes them over it). Rather than leave the
  pre-existing duplication in place and suppress the lint error, both are
  consolidated into one `simpleParagraph(text, pageBreakBefore?)` used at both
  call sites. Neither name had external references, so this is a clean,
  low-risk single-file rename/merge, not a new abstraction reaching across
  module boundaries.
- No database migration and no `SpecNode`/`SpecTree` reshaping — the field
  rides inside the existing `meta` JSONB blob, following the same pattern as
  `meta.vanish` and `meta.conflicts`.
- Decision 6's forwarding/redirect logic (`pageBreakMeta`,
  `resolvePageBreakBefore`) was extracted into its own sibling module,
  `src/parser/docx/page-break.ts`, purely to keep `inference.ts` under the
  repo's 400-line file budget — no module-boundary change, both files stay in
  the same `parser/docx` package.
