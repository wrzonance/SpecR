# ADR-086: asterisk rule rows stay suppressed, not reclassified as notes

## Status

Accepted

## Context

Three separate reports (#512, #471, #514) flagged the same symptom against
`paring-fixes.integration.test.ts`'s "Related Sections numbering (#122)"
fixture: the note-count assertion at the end of that test dropped from a
floor of 4 to 2 note nodes, read as a regression to investigate.

`da0c465664581d174fde5357aa5679d8eefe5ae2` ("feat(parser): wire note-role
classification into inference.ts", merged as part of PR #461/#292) is the
exact commit that changed the count. It made `classifyOne`
(`src/parser/docx/inference.ts`) check `role === 'rule'` first — suppressing
an asterisk-delimited rule row (`text: '*****'`) into no `SpecNode` at all —
strictly before the pre-existing style-based note check
(`role === 'note' || isNoteParagraph(para, styleMap)`). Before that commit,
a rule row whose Word style happened to resolve to a name matching
`isNoteParagraph`'s `/note/i` regex (e.g. `STNoteSpec`, the style the
`paring-fixes.docx` fixture's asterisk banners carry) fell through to the
style check and was misclassified as a `note` node. The fixture's two
asterisk-rule rows were exactly those two accidental hits: 4 = 2 genuine
`STNoteSpec` note-text paragraphs + 2 misclassified rule rows.

The decisive evidence that the pre-#461 count was the bug, not the fix, is
in the renderer. `src/generator/markdown.ts`'s `renderNonStructural`
renders any `node.type === 'note'` unconditionally as
`` `\n> **[NOTE]** ${node.text}` `` — there is no further filtering. Pre-#461,
an 85-character asterisk rule row misclassified as a note would have
rendered as a literal `> **[NOTE]** *************************************...`
line: decorative noise masquerading as an editorial banner, never a
deliberate spec-writer note. #292's `role === 'rule'` ordering is a genuine
correctness fix for that, not a regression to undo.

`inference.ts`'s own module comment states the intent directly: a rule-row
delimiter is never structural content. The three-times-filed confusion is
because the original `#122` test comment ("The leading specifier-note
banners remain... floor of 4") predates `da0c4656` — per `git log --follow`
only one other commit (`9fcf6007`) ever touched that test file — and
describes what the _old_ code accidentally did, not a deliberate invariant.

## Decision

Keep `role === 'rule'` suppression running ahead of the style-based note
check in `classifyOne`, exactly as `da0c4656`/#292 shipped it. Re-pin
`paring-fixes.integration.test.ts`'s note count to **exactly** 2 — the genuine
`STNoteSpec` note-text paragraph count — with the assertion comment
rewritten to cite this ADR and the causal commit, so a fourth filer finds
the answer instead of refiling. Add a regression test in
`inference-notes.test.ts`'s existing `#292` describe block pinning that a
rule row carrying a note-family style (`STNoteSpec`) still suppresses,
isolating the exact ordering this ADR documents.

Restoring the pre-#461 behavior was rejected: it would reintroduce
decorative-asterisk-wall noise as fake `[NOTE]` bubbles for every
asterisk-delimited region sharing a note-family style corpus-wide — a much
larger blast radius than one fixture's historical count, and a regression
in the renderer's own output, not merely a test-assertion mismatch.

## Consequences

- No production-code path under `src/` changed; the regression tests that did
  change also live under `src/`. `pnpm fixture:diff` across the full corpus is
  expected to show literally zero diff.
- The `paring-fixes.integration.test.ts` **exact count** of 2 is now the
  documented, intentional invariant — deliberately not a `>= 2` floor, which
  would still admit the historical four-note output this ADR exists to rule
  out — and any future PR that changes it must cite a new
  causal commit or mark the change `KNOWN AMBIGUITY`, per this repo's
  standing rule for note-count/behavior changes.
- Future asterisk-rule-row work should keep the `role === 'rule'` check
  ahead of every downstream note/vanish/style branch in `classifyOne` — the
  ordering itself is the invariant, not just this one fixture's count.
