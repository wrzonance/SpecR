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
7. **Persist as a dedicated column** (`page_break_before`, migration 050;
   #497 review finding). `paragraphs` has no catch-all `meta` JSONB — every
   `meta.*` field maps to an explicit column written and reconstructed by name
   (`vanish`, `conflicts`, `source_facts`, `signal_provenance`, `object_data`).
   `pageBreakBefore` is a paragraph-level boolean with exactly `vanish`'s shape
   and lifecycle, so it takes its own `boolean NOT NULL DEFAULT false` column,
   wired symmetrically into the write path (`insertTree`/`flattenDfs`), both read
   paths (`getSpecTree`→`buildNodeTree` and `getParagraphWithAncestors`), and the
   project-derive clone (`derive.ts cloneParagraphs`). Without persistence the
   flag survives only the in-memory parser→generator path and is silently dropped
   by the real upload → parse → **persist** → generate REST flow — the path every
   uploaded document actually takes.
8. **Capture BOTH source forms of a manual break** (`document.ts`,
   `ownPageBreakBefore`; #497 review finding). A manual page break appears in a
   real source `.docx` in two forms, and the original lookback caught only one.
   The first is a `w:br type="page"` run at the end of the *preceding* paragraph
   (Word's "Insert → Page Break") — the predecessor's `previousParagraphHasPageBreak`
   lookback. The second is a paragraph-level `w:pageBreakBefore` property *on* the
   paragraph that begins the new page, produced by Word's Paragraph dialog → "Line
   and Page Breaks" → "Page break before" and set by many heading styles — captured
   by `ownPageBreakBefore`. Both are common authoring patterns; a document using
   only the property form previously lost its breaks entirely. (This is also the
   exact property the generator re-emits per decision 1, so capture and emission
   name the same node — but the justification is the source-authoring form, NOT a
   re-import of SpecR's own generated `.docx`: the generator wraps every content
   paragraph in a `w:sdt` UUID merge anchor and `parse()` reads only direct
   `w:body/w:p` children, so a generated file is re-integrated through the merge
   engine, never re-parsed into a fresh tree.) CT_OnOff toggle semantics: the
   element present === on, unless an explicit falsey `w:val` (false/0/off) disables it.
9. **Keep the two capture signals distinct on `DocxParagraph`** (`pageBreakBefore`
   vs `ownPageBreakBefore`; #497 second review round). Decision 8's two forms are
   NOT interchangeable across an interposed body object. The predecessor-`w:br`
   form can be a misattribution (decision 4 / the third KNOWN AMBIGUITY below), so
   `resolvePageBreakBefore` drops it when an object sits at `i-1`. The paragraph's
   OWN `w:pageBreakBefore` property never is — it is intrinsic to that paragraph —
   so it must survive across the interposed object. Collapsing both into one
   boolean (the first draft did) wrongly dropped a legitimate own-property break
   after a table; keeping them separate fixes it.
10. **Forward a break past a node the generator will drop** (`inference.ts`
    `buildTree`; #497 second review round). A hidden non-note paragraph becomes a
    `meta.vanish` `continuation` that every renderer drops (#296). A break resolved
    onto it would vanish from the generated DOCX, so `buildTree` forwards it (via
    `pendingPageBreak`) to the next ACTUALLY-emitted node instead of consuming it
    on a node no one renders. A note is exempt — it renders as `[NOTE]` and carries
    the break itself.
11. **Persist AND round-trip the field through every tree path, not just the
    primary read** (#497 second review round). `meta.pageBreakBefore` is a
    first-class canonical AST field, so it must be wired into: the AST Zod schema
    (`SpecNodeMetaSchema` — a plain `z.object` silently STRIPS any field it does
    not declare, so an omission drops the flag on every validated path, including
    package-revision snapshots that validate through `SpecTreeSchema` before
    storing); and every path that rebuilds a `SpecNode` tree from paragraph rows —
    `getSpecTree`→`buildNodeTree`, `getParagraphWithAncestors`, the subtree
    reconstruction (`paragraphs.ts` `buildSubtree`/`fetchSubtreeNode`, which backs
    PATCH/insert/vanish responses), the package-revision snapshot SELECT
    (`revisions.ts`), and the project-derive clone (`derive.ts`). A single missed
    path is a silent, path-dependent data loss.

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
- One additive, reversible migration (050) and no `SpecNode`/`SpecTree`
  reshaping. The field persists as a dedicated `page_break_before` column
  following the same pattern as `meta.vanish`'s `vanish` column (decision 7) —
  `paragraphs` has no shared `meta` JSONB, so a new `meta.*` field is a new
  column, wired by name into the write path, both read paths, and the
  project-derive clone. (An earlier draft of this ADR mistakenly asserted no
  migration was needed "because the field rides inside the existing meta JSONB
  blob" — there is no such blob; that omission silently dropped the flag on
  every persisted spec and was caught in review.)
- Decision 6's forwarding/redirect logic (`pageBreakMeta`,
  `resolvePageBreakBefore`) was extracted into its own sibling module,
  `src/parser/docx/page-break.ts`, purely to keep `inference.ts` under the
  repo's 400-line file budget — no module-boundary change, both files stay in
  the same `parser/docx` package.
