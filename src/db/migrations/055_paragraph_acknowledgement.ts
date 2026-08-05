import type { MigrationBuilder } from 'node-pg-migrate';

// #545, ADR-079 follow-on — closes the "no supported API path to clear a
// readiness finding" gap for the two finding kinds that need per-node state
// (specifier_note_present, body_object_present) rather than a text
// re-derivation (unresolved_choice_token, handled by re-deriving
// source_facts.choiceTokens on text edit — no schema change needed there)
// or a facts toggle (open_comment, handled by mutating source_facts.comments
// — also no schema change needed).
//
// `acknowledged` is a per-node boolean, structurally identical to `vanish`
// (migration 003) and `page_break_before` (migration 050): a paragraph-level
// flag with no catch-all `meta` column to ride on. It is deliberately NOT the
// vanish mechanism and NOT added to REMOVABLE_NODE_TYPES
// (paragraph-vanish.ts) — the comment above that set explains why storing
// vanish on `note`/`object` nodes would silently lie about the removal
// contract (both renderers emit/consider those types before ever checking
// vanish). Acknowledgement never suppresses content; it only affirms a human
// has seen it, so it must never be consulted by any renderer.
//
// paragraph_versions_op_check (migration 046) is widened with four new ops:
// `acknowledge`/`unacknowledge` (the new toggle's history rows) and
// `close-comment`/`reopen-comment` (the new comment-closure toggle's history
// rows, including the side effect wired into acceptCommentAsNote). Mirrors
// migration 046's own OPS_SQL_LIST pattern exactly — the literal is
// duplicated in src/db/queries/paragraph-history.ts's PARAGRAPH_HISTORY_OPS
// and must be kept in lockstep by hand (migrations are frozen snapshots,
// never imported into runtime src/).
const OPS = [
  'edit',
  'insert',
  'remove',
  'restore',
  'merge',
  'accept-note',
  'restructure',
  'acknowledge',
  'unacknowledge',
  'close-comment',
  'reopen-comment',
] as const;
const OPS_SQL_LIST = OPS.map((op) => `'${op}'`).join(', ');

const CONSTRAINT_NAME = 'paragraph_versions_op_check';

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    acknowledged: { type: 'boolean', notNull: true, default: false },
  });
  pgm.dropConstraint('paragraph_versions', CONSTRAINT_NAME);
  pgm.addConstraint('paragraph_versions', CONSTRAINT_NAME, {
    check: `op IN (${OPS_SQL_LIST})`,
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('paragraph_versions', CONSTRAINT_NAME);
  pgm.addConstraint('paragraph_versions', CONSTRAINT_NAME, {
    check: `op IN (${['edit', 'insert', 'remove', 'restore', 'merge', 'accept-note', 'restructure']
      .map((op) => `'${op}'`)
      .join(', ')})`,
  });
  pgm.dropColumns('paragraphs', ['acknowledged']);
};
