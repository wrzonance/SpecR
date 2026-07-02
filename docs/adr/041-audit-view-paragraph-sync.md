# ADR-041: Live coordination audit view — finding↔paragraph sync model

## Status

Accepted. Scope: `examples/web_ui_demo/` only (the reference client). No `src/`
or `openapi.yaml` change is required or made by this ADR.

## Context

The demo's Report tab stacked three read-only bands (coordination report, open
review comments, submittal register). A spec writer auditing coordination
findings had to leave the Report, switch to the Project Spec Map, and hunt for
the cited section — losing the finding's context on every hop.

We want a **side-by-side audit experience**: the coordination findings and the
cited spec render together, and navigating one pane drives the other. The open
question was the linkage key: can a finding be joined to an *exact paragraph* in
a rendered spec without inventing a new anchor scheme or changing the backend?

Discovery answered it. A stable per-paragraph anchor already exists end-to-end:

- `paragraphs.id` (a UUID) is the AST node id (`SpecNode.id`), the `:nodeId`
  path param, and the value surfaced on findings as `sourceParagraphId`.
- The demo's spec renderer already stamps every paragraph row with
  `data-node-id="<uuid>"` (`tree.js` `renderPrNode`), and every sheet with
  `id="sheet-<treeId>"` where `treeId === specId`.
- Four finding types carry `sourceParagraphId` today (no backend change):
  `dangling_ref`, `implied_related_section`, `product_without_submittal_type`,
  `product_missing_datasheet`. The rest are section-level by nature.

So the finding→paragraph join is `(finding.sourceSpecId, finding.sourceParagraphId)`
→ `#sheet-<id>` + `[data-node-id="<uuid>"]`, using identifiers that already exist
in both the payload and the DOM.

## Decision

1. **Split within the Report, not a new tab.** The Report tab becomes a
   two-pane split: left = the coordination + open-comments findings (unchanged
   renderers), right = a spec pane. The writer enters Report and stays there.
   The split is a CSS grid with a draggable divider (default 1:1, clamped
   20–80%, keyboard-adjustable); it collapses to a single stacked column under
   900px. Each pane scrolls independently within a viewport-bounded height.

2. **Reuse the existing paragraph anchor — invent nothing.** Finding→paragraph
   navigation uses the existing `data-node-id` UUID. Coordination finding rows
   are stamped with `data-spec-id` / `data-paragraph-id` (in addition to the
   existing `data-section`). The spec pane reuses `renderSpecSheet` verbatim and
   the exported `expandAncestors` before scrolling. Anchored finding types scroll
   to the exact paragraph and pulse-highlight it; section-only types open the
   sheet (head into view); a finding whose section is not loaded shows a
   placeholder explaining why.

3. **Reuse the spec-map prev/next affordance.** `popover.js` is refactored into a
   `createHoverWalker` factory; the spec-map citation walk keeps byte-identical
   hover-only behavior, and the audit findings walker is a second instance over
   `.coord-finding` rows with keyboard stepping (Arrow keys), a focus trigger,
   and an `aria-live` counter. Stepping selects the finding (Report pane) and
   drives the spec pane in sync.

4. **Bidirectional selection.** Clicking a citation (`.ref-link`, via the pane
   sheet's `onNavigate`) or a paragraph row in the spec pane reflects back to and
   highlights the matching finding on the left (`data-section` /
   `data-paragraph-id` lookup). Acting in either pane updates the other.

5. **Stay in the Report.** The spec pane's citation clicks and the open-comments
   section badges drive the audit panes instead of switching to the map view.

The controller lives in a new `js/audit.js` (following the `initNumbering`
lifecycle-controller pattern) so `app.js` does not grow further; it depends only
on capabilities `app.js` injects (no back-references).

## Consequences

- Zero backend/contract change; works today for the four anchored finding types
  at paragraph precision and for the rest at section precision. Giving the
  section-only types a paragraph anchor is a future `src/` change, out of scope.
- The audit spec pane renders the same `.spec-sheet` as the board; its duplicate
  `id` is dropped (the pane holds the element reference and queries it directly),
  so no `getElementById` collision with the board sheet.
- Submittal register moves to its own top-level tab (it is not part of the
  finding↔paragraph audit loop), keeping the Report focused on coordination.
- Bounded pane height is a pragmatic `calc(100vh - chrome)` rather than a precise
  flex measurement; short viewports get a scrollbar, which is acceptable for
  a reference demo.
