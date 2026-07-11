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
  // The item carries its own structural list numbering (a numbered heading or list
  // item). A specifier note never encloses numbered structural content, so such an
  // item appearing INSIDE an open rule-row region is proof the asterisk pairing has
  // drifted — an unpaired or content-merged wall (e.g. "…Waste Management *****")
  // left the open/closed toggle out of phase. Stronger than isHeading, which is a
  // text-shape guess: this is independent numbering evidence. Optional so callers
  // that carry no numbering signal (and the format-agnostic unit tests) omit it.
  readonly isStructural?: boolean;
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
 * the edge cases this resolves (heading-closed and end-of-stream-closed unpaired
 * openers) and why they are documented rather than "fixed".
 *
 * DRIFT GUARD (#292): if a structural (numbered) item is ever enclosed by an open
 * region, the asterisk pairing has drifted out of phase — hand-authored docs merge a
 * closing wall into note prose or drop one entirely, so the naive toggle swallows
 * real PART/article/list content it should never touch. There is no per-region
 * recovery that stays byte-faithful to the pre-feature classification (every wall the
 * feature suppresses is a change), so the only safe response is to disengage for the
 * whole document: fall back to per-paragraph classification (every role 'none'). The
 * document's notes are still recovered downstream by style/banner signals exactly as
 * before the asterisk convention existed.
 */
export function classifyNoteRoles(items: readonly NoteScanItem[]): NoteRole[] {
  const roles = assignRoles(items);
  // A structural item that landed in a 'note' role WAS enclosed by an open region
  // (only an open, non-heading, non-rule item is tagged 'note') — the drift proof.
  const drifted = items.some((item, i) => roles[i] === 'note' && item.isStructural === true);
  return drifted ? roles.map(() => 'none') : roles;
}

/** The clean single-pass toggle — rule rows flip open/closed, headings force-close. */
function assignRoles(items: readonly NoteScanItem[]): NoteRole[] {
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
