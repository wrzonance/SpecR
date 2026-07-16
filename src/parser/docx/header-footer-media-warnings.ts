// Aggregates #502's relsUnreadable-part unmodeled entries (header-footer-
// images.ts's relsUnreadableEntry, header-footer-table.ts's
// imageUnmodeledEntry) into exactly one capture-warning line per damaged
// part, instead of header-footer.ts's generic per-entry unmodeledWarningLine
// emitting one line PER DRAWING for the same damaged part (issue #502
// acceptance: "One part-level capture warning"). Extracted to its own
// sibling file because header-footer.ts is already at ESLint's max-lines
// cap (400, CLAUDE.md) — this stays well under budget.

import type { HeaderFooterUnmodeledEntry } from './types.js';

/**
 * Narrows an unmodeled entry's `detail` to #502's relsUnreadable shape --
 * `{ part: string, reason: string, rId?: string }` -- as produced by
 * header-footer-images.ts's relsUnreadableEntry (carries rId) and
 * header-footer-table.ts's imageUnmodeledEntry (no rId — the table-cell path
 * never parses a drawing descriptor). Every OTHER unmodeled-entry producer in
 * this module family (header-footer.ts's missingPartEntry/
 * unresolvedToUnmodeled/duplicateReferenceEntry) keys its detail on `target`
 * or `rId` alone, never `part`, so checking for a string `part` field is
 * sufficient to distinguish the two families without also inspecting
 * `reason` or the entry's `kind` (pinned: header-footer-media-warnings.test.ts's
 * non-interference tests against all three pre-existing shapes).
 */
export function isRelsUnreadableDetail(detail: unknown): detail is { readonly part: string } {
  if (typeof detail !== 'object' || detail === null) return false;
  return typeof (detail as Record<string, unknown>).part === 'string';
}

/**
 * Groups every #502 relsUnreadable unmodeled entry by its damaged part path
 * and emits exactly one aggregate capture-warning line per unique part,
 * never one line per drawing (INV-5). A part with zero qualifying entries —
 * including one whose unmodeled entries are all pre-existing
 * unresolvedReference shapes with no `part` field — emits no warning at all;
 * there is nothing to aggregate (INV-8). The SAME damaged part referenced
 * from more than one variant/region slot (default/first/even x header/
 * footer) dedupes naturally via the Map keyed on `detail.part`, since every
 * relsUnreadable entry for that part carries the identical `part` string
 * regardless of which slot produced it (INV-5).
 */
export function buildRelsUnreadableWarnings(
  unmodeled: readonly HeaderFooterUnmodeledEntry[]
): readonly string[] {
  const countsByPart = new Map<string, number>();
  for (const entry of unmodeled) {
    if (!isRelsUnreadableDetail(entry.detail)) continue;
    countsByPart.set(entry.detail.part, (countsByPart.get(entry.detail.part) ?? 0) + 1);
  }
  return [...countsByPart.entries()].map(
    ([part, count]) =>
      `${part}'s relationships index is unreadable; ${count} image reference(s) could not be resolved`
  );
}
