// Itemizes drawing runs living in this parser's "discard paths" — content the
// base capture architecture (ADR-068/ADR-071) preserves whole as an opaque
// raw unmodeled entry (`extraParagraph`, `table`) rather than visiting per-run,
// unlike the two SITES it already visits (the first content-bearing paragraph
// and the first table's cells — header-footer-images.ts's resolveDrawingImage,
// header-footer-table.ts's captureTableCell). #505 (#502 follow-up): when the
// owning part's own .rels file is itself unreadable, a drawing living in one
// of these discard paths was STILL preserved verbatim inside its raw entry
// (content was never lost) but was not itemized as its own
// `unresolvedReference`, so the part-level aggregate warning
// (header-footer-media-warnings.ts) undercounted it. Both scanners below are
// pure, total, never throw, and never mutate their input; both short-circuit
// to `[]` unless `partMedia?.status === 'relsUnreadable'` — a `resolved` or
// absent `partMedia` leaves every discard path exactly as it behaved before
// this issue (#502's own base architecture is otherwise unaffected).
//
// The two scanners deliberately preserve the #502 paragraph/table ASYMMETRY
// (issue #505's "why this is a deliberate follow-up" section):
//  - itemizeParagraphDiscardDrawings is DESCRIPTOR-GATED (INV-2): a drawing
//    with no parseable descriptor (no r:embed / no wp:extent) is never
//    itemized — a drawing that never referenced a relationship is not made
//    "unresolvable" just because the index is damaged. Mirrors
//    resolveDrawingImage's own arm-1-before-arm-2 ordering
//    (header-footer-images.ts).
//  - itemizeTableDiscardDrawings is UNGATED (INV-3): table-cell images are
//    out of scope regardless of descriptor validity (ADR-071 decision 4), so
//    every drawing run converts unconditionally — mirrors
//    header-footer-table.ts's own imageUnmodeledEntry, relocated here
//    verbatim so both discard scanners share one file.

import { compact } from './xml-utils.js';
import { isDrawingRun, runsOf } from './header-footer-region.js';
import type { PartialUnmodeled } from './header-footer-region.js';
import { parseDrawingDescriptor, relsUnreadableEntry } from './header-footer-images.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterPartMedia } from './header-footer-media-parts.js';

/**
 * Relocated verbatim from header-footer-table.ts (#309/#502, now shared with
 * itemizeTableDiscardDrawings below). A table-cell drawing run normally
 * becomes an unmodeled `image` entry verbatim (ADR-071 decision 4:
 * table-cell images are out of scope, regardless of rels-index health). When
 * the owning part's own .rels file is itself unreadable, every drawing in
 * that cell is unresolvable by construction — that gets its own
 * `unresolvedReference` entry (part + reason, no `rId`: this layer never
 * parses a drawing descriptor to find one) so
 * header-footer-media-warnings.ts can attribute one capture-warning per
 * damaged part instead of a generic "image content not modeled" line.
 */
export function imageUnmodeledEntry(
  run: Record<string, unknown>,
  partMedia: HeaderFooterPartMedia | undefined
): PartialUnmodeled {
  if (partMedia?.status === 'relsUnreadable') {
    return {
      kind: 'unresolvedReference',
      detail: compact({ part: partMedia.partPath, reason: RELS_UNREADABLE_REASON }),
    };
  }
  return { kind: 'image', detail: compact(run) };
}

/**
 * #505: itemizes the drawing runs inside already-discarded EXTRA (2nd+)
 * content-bearing paragraphs — each paragraph itself is still preserved
 * whole elsewhere as its own `extraParagraph` unmodeled entry (this scanner
 * never replaces that; it ADDS a companion `unresolvedReference` per
 * qualifying drawing so the part-level aggregate warning counts it, matching
 * the FIRST paragraph's own drawing handling in resolveDrawingImage).
 * Short-circuits to `[]` unless `partMedia?.status === 'relsUnreadable'`.
 *
 * DESCRIPTOR-GATED (INV-2): a drawing run only converts when
 * `parseDrawingDescriptor` finds a resolvable rId + EMU size — a
 * descriptor-less drawing is left out entirely (still only preserved inside
 * its paragraph's raw `extraParagraph` detail), matching the paragraph
 * path's existing asymmetry rather than the table path's ungated conversion.
 * Pure, total, never throws, never mutates `discardedParagraphs`.
 */
export function itemizeParagraphDiscardDrawings(
  discardedParagraphs: readonly Record<string, unknown>[],
  partMedia: HeaderFooterPartMedia | undefined
): readonly PartialUnmodeled[] {
  if (partMedia?.status !== 'relsUnreadable') return [];
  const { partPath } = partMedia;
  const entries: PartialUnmodeled[] = [];
  for (const paragraph of discardedParagraphs) {
    for (const run of runsOf(paragraph)) {
      if (!isDrawingRun(run)) continue;
      const descriptor = parseDrawingDescriptor(run);
      if (!descriptor) continue;
      entries.push(relsUnreadableEntry(descriptor.rId, partPath));
    }
  }
  return entries;
}

/**
 * #505: itemizes the drawing runs inside already-discarded table-path
 * nodes — an unsupported table returned whole (0 rows / nested table /
 * unsupported merge, `captureTable`) or an extra (2nd+) root-level table
 * (`captureTablesForRegion`, `.slice(1)`) — mirroring the FIRST table's own
 * per-cell scan (header-footer-table.ts's captureTableCell). Short-circuits
 * to `[]` unless `partMedia?.status === 'relsUnreadable'`.
 *
 * UNGATED (INV-3): every drawing run converts via `imageUnmodeledEntry`
 * regardless of descriptor validity — table-cell images are out of scope
 * regardless (ADR-071 decision 4), matching the table path's existing
 * ungated conversion rather than the paragraph path's descriptor gate.
 * `discardedNodes` deep-walks any node shape (a `w:p`, a `w:tbl`, or an array
 * of either) generically via `runsOf`'s own traversal — a discarded
 * `w:tbl`'s runs live several levels below any single paragraph, exactly
 * like a table cell's runs already do. Pure, total, never throws, never
 * mutates `discardedNodes`.
 */
export function itemizeTableDiscardDrawings(
  discardedNodes: readonly Record<string, unknown>[],
  partMedia: HeaderFooterPartMedia | undefined
): readonly PartialUnmodeled[] {
  if (partMedia?.status !== 'relsUnreadable') return [];
  const entries: PartialUnmodeled[] = [];
  for (const node of discardedNodes) {
    for (const run of runsOf(node)) {
      if (!isDrawingRun(run)) continue;
      entries.push(imageUnmodeledEntry(run, partMedia));
    }
  }
  return entries;
}
