// Pure, format-agnostic note-region classification shared by every parser (DOCX today,
// text/PDF in a future phase — see #294). No parser types leak in here; adapters (e.g.
// src/parser/docx/note-roles.ts) translate their own paragraph shape into NoteScanItem.

const RULE_ROW_MIN = 5;
const RULE_ROW_PATTERN = /^\*+$/;

/**
 * True iff the trimmed text is RULE_ROW_MIN-or-more asterisks and nothing else.
 * Asterisk-only, on purpose — dashes/equals/bullets/mixed decoration continue to be
 * handled by the existing isDecorationSeparator path in src/parser/docx/heuristics.ts
 * and are NOT rule rows for note-delimiter purposes.
 */
export function isRuleRow(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= RULE_ROW_MIN && RULE_ROW_PATTERN.test(trimmed);
}

/** One scannable item in a note-delimiter stream, independent of source format. */
export interface NoteScanItem {
  readonly text: string;
  readonly isHeading: boolean;
}

/** The role a scanned item plays relative to an asterisk-rule-delimited note region. */
export type NoteRole = 'rule' | 'note' | 'none';

/**
 * Classifies each item in `items` by its role in a rule-row-delimited note region.
 * Index-aligned 1:1 with `items` — always returns exactly `items.length` roles.
 *
 * A single left-to-right pass toggles an open/closed flag on each rule row (tagged
 * 'rule' whether it opens or closes a region). While open, ordinary items are tagged
 * 'note'. A heading force-closes an open region as a safety break and is itself
 * tagged 'none' — see the KNOWN AMBIGUITY cases pinned in note-delimiters.test.ts for
 * the two edge cases this resolves (heading-closed and end-of-stream-closed unpaired
 * openers) and why they are documented rather than "fixed".
 */
export function classifyNoteRoles(items: readonly NoteScanItem[]): NoteRole[] {
  const roles: NoteRole[] = [];
  let open = false;

  for (const item of items) {
    if (isRuleRow(item.text)) {
      open = !open;
      roles.push('rule');
      continue;
    }
    if (item.isHeading) {
      open = false;
      roles.push('none');
      continue;
    }
    roles.push(open ? 'note' : 'none');
  }

  return roles;
}
