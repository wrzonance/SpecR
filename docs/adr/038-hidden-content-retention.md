# ADR-038: Hidden OOXML content is retained, not discarded, and excluded from inference

## Status
Accepted — 2026-06-25

## Context
Firm master specs carry hidden (`w:vanish`) document-control content — processing
forms, sign-off and revision-history tables — and bracket editor notes with rows of
asterisks. This hidden material polluted the 5-signal CSI inference (root junk) and
the asterisk rows rendered as literal walls of text. SpecR will eventually use this
hidden material to track master/project edits, so it must not be destroyed.

## Decision
1. Detect hidden paragraphs robustly (run-level, paragraph-mark, paragraph-style, and
   character-style vanish). A paragraph is hidden only when fully hidden (mixed
   visible/hidden runs count as visible — the visible text is real content).
2. Hidden paragraphs are excluded from structural inference but retained in-tree as
   suppressed `note` nodes, preserving UUID round-trip/merge anchors.
3. Hidden tables are parsed and retained as a flat `SpecTree.hiddenTables` grid
   (lossless cell text), out of the hierarchy. Visible tables are detected and warned
   (`table-content-skipped`), not modeled this sprint.
4. Asterisk rule rows (`*****…`) are a note-delimiter convention: the rows are stripped,
   the enclosed paragraphs become `note` nodes, detected by content (not style name).

## Consequences
- The CSI hierarchy is clean; hidden content is recoverable for the future
  change-management/document-control feature.
- A typed revision-history schema, visible-table modeling, DB persistence of retained
  tables, and learning the conventions into firm profiles are explicit follow-ups.
