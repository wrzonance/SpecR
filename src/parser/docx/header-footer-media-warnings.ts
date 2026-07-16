// Aggregates #502's relsUnreadable-part unmodeled entries (header-footer-
// images.ts's relsUnreadableEntry, header-footer-table.ts's
// imageUnmodeledEntry) into exactly one capture-warning line per damaged
// part, instead of header-footer.ts's generic per-entry unmodeledWarningLine
// emitting one line PER DRAWING for the same damaged part (issue #502
// acceptance: "One part-level capture warning"). Extracted to its own
// sibling file because header-footer.ts is already at ESLint's max-lines
// cap (400, CLAUDE.md) — this stays well under budget.

import { asRecord } from './xml-utils.js';
import { RELS_UNREADABLE_REASON } from './header-footer-media-parts.js';
import type { HeaderFooterUnmodeledEntry } from './types.js';

// The exact shape header-footer-images.ts's relsUnreadableEntry (carries rId)
// and header-footer-table.ts's imageUnmodeledEntry (no rId — the table-cell
// path never parses a drawing descriptor) both produce for a #502
// relsUnreadable part.
type RelsUnreadableEntry = HeaderFooterUnmodeledEntry & {
  readonly kind: 'unresolvedReference';
  readonly detail: { readonly part: string; readonly reason: string };
};

/**
 * Classifies a WHOLE unmodeled entry (not just its `detail`) as a #502
 * relsUnreadable entry: `kind === 'unresolvedReference'` AND a string `part`
 * AND `reason === RELS_UNREADABLE_REASON`. Matching on the full triple —
 * rather than a bare string `part` field — keeps a future or crafted entry
 * that merely happens to carry `detail.part` (a different kind, or an
 * unrelated reason) from being pulled out of the generic warnings and
 * mislabeled as an unresolvable image, which would silently lose its real
 * warning. Every pre-existing unresolvedReference producer in this module
 * family (header-footer.ts's missingPartEntry/unresolvedToUnmodeled/
 * duplicateReferenceEntry) keys its detail on `target`/`rId`, never `part`
 * with this reason, so it is correctly excluded (pinned:
 * header-footer-media-warnings.test.ts's non-interference + negative tests).
 */
export function isRelsUnreadableEntry(
  entry: HeaderFooterUnmodeledEntry
): entry is RelsUnreadableEntry {
  if (entry.kind !== 'unresolvedReference') return false;
  const record = asRecord(entry.detail);
  if (!record) return false;
  return typeof record.part === 'string' && record.reason === RELS_UNREADABLE_REASON;
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
    if (!isRelsUnreadableEntry(entry)) continue;
    countsByPart.set(entry.detail.part, (countsByPart.get(entry.detail.part) ?? 0) + 1);
  }
  return [...countsByPart.entries()].map(
    ([part, count]) =>
      `${part}'s relationships index is unreadable; ${count} image reference(s) could not be resolved`
  );
}
