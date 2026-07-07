import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ADR-055: persist 5-signal hierarchy-inference provenance per paragraph.
 * Wire shape: { signalUsed: 1|2|3|4|5, agreed: (1|2|3|4|5)[] }.
 * NULL = honestly unscored (pre-provenance parse, non-DOCX source, or
 * non-structural node) — no backfill, never a fake value. The confidence
 * score is derived at READ time (scoreHierarchyConfidence), never persisted,
 * so the formula can improve without migration or reparse.
 * No CHECK on JSONB shape — the Zod schema at the query boundary is
 * authoritative (hybrid validation, ADR-021). Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    signal_provenance: { type: 'jsonb' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['signal_provenance']);
};
