# ADR-043: Manual outline numbers are stripped by label-match, not text heuristics

## Status
Accepted — 2026-07-01

## Context
Manufacturer DOCX specs frequently type the CSI outline number into the heading
text itself ("1.2 RELATED SECTIONS", "1.4.2.1 Installation") instead of relying on
Word's numbering. SpecR's generator re-derives every label from sibling position
(`getLabel`, ADR-adjacent to the render-derived numbering model), so any typed number
left in `article.text` renders **doubled** — "1.2 1.2 RELATED SECTIONS". The parser
must therefore strip the author-typed number, storing only the clean title.

The hard part: a single-dot leading number "N.N" is genuinely ambiguous between an
outline **label** ("1.2 SUMMARY") and a decimal **value** that merely opens the text
("2.1 GHz frequency band", "1.1 inches of clearance minimum"). Every text-only rule
tried has a real counterexample:

- Strip when followed by `[A-Z]` → drops "2.0 **G**Hz" (capital unit looks like a title).
- Maintain a unit dictionary → open-ended ("N.N Some-unit-thingy"); fragile; misses units.
- Classify by title shape (all-caps / Title-Case) → "1.2 600 V Power Receptacle" (a real
  digit-leading heading) is indistinguishable from "1.2 600 volts minimum" (a value).

Three successive text-heuristic fixes each surfaced a new counterexample elsewhere — the
systematic-debugging signal that the *classification* approach was wrong, not the tuning.
The cardinal product rule (thewrz): **never lose measurement data** — "countless specs
will have 2.1 GHz / 1.5 MHz / N.N unit and must work day one without breaking."

An alternative was considered and **rejected**: store text verbatim and de-duplicate at
render time (skip prepending `getLabel` when the text already leads with the computed
label). It is zero-loss on first render, but SpecR is an **editing/merge** platform:
when an article is renumbered (a section is inserted/reordered) the baked-in number no
longer matches its new computed label, so the render doubles again ("1.2 1.1 SUMMARY").
Storing clean titles and always recomputing the label is what makes labels survive
renumbering — the whole point of the merge engine.

## Decision
1. **Multi-dot outline numbers** (`1.4.2.1`, ≥2 interior dots) are stripped inline,
   unconditionally — a measurement is never multi-dot and pr-level render labels
   (`A.`, `1.`) never contain the typed decimal (`planOutlineNumberStrip`).
2. **Single-dot article numbers** are stripped in a post-pass over the assembled tree
   (`planLabelStrip` + `stripArticleOutlineLabels`), and **only** when the typed number
   *equals the article's own sibling-derived CSI label* — the position, computed by the
   same ordinal walk the renderer uses (`consumesNumber`). Position, not text, is the
   discriminator. A measurement is stripped only if its number happens to be that exact
   ordinal's label — otherwise it is preserved whole.
3. **Scope gate:** the strip runs only on Signal-4 (manual text-outline) articles. A
   Word/style-numbered article (Signal 1/2) draws its number from the numbering
   definition, so its visible text is real content and is never touched.
4. **Conservative uppercase guard:** even at a matching label, strip only when an
   uppercase letter follows — a heading is a Title (ALL-CAPS/Title-Case); decimal prose
   and lowercase-unit measurements ("1.1 mm tolerance", "2.1 kHz clock") open lowercase
   or with a digit and are preserved. This is strictly more conservative than a bare
   match: it can only ever keep more data, never lose more.
5. `getLabel`/`consumesNumber` are single-sourced in `src/ast/labels.ts` so the parser
   (strips the typed duplicate) and generator (prepends the computed label) agree by
   construction, and are reached through the `ast` barrel per the module-boundary rule.

## Consequences
- Real headings at their labeled position strip clean; measurements and decimal prose
  keep their values. Verified as a **0-node-difference** no-op across the 34-spec
  reference corpus vs. the prior behavior, in the data-preserving direction.
- **KNOWN AMBIGUITY (documented in test):** a capital-unit measurement ("1.2 GHz …")
  that is *itself* a Signal-4 top-level article sitting at *exactly* its own label
  ordinal is textually identical to a heading and is stripped. This is the irreducible
  intersection of (capital unit) × (Signal-4 article) × (exact-ordinal match); it does
  not occur in the corpus, and real measurements live in pr-level content/continuations,
  which the article-only strip never touches. Preferring "keep" here would re-double the
  label on every genuine heading — the bug this pass fixes.
- Source-fact offsets (comments, colors, choice tokens) are rebased after a strip so
  editor metadata keeps pointing at the right characters.
- A separate, out-of-scope ambiguity remains: Signal-5 indentation over-promoting deep
  prose to phantom top-level articles (WIRELESS PRODUCTS), which shifts real-article
  ordinals. Tracked independently.
