import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #56: persist 5-signal inference disagreements per paragraph.
 * Wire shape: [{ signal: 1|2|3|4|5, reportedIlvl: int, reportedNodeType: NodeType }].
 * No CHECK constraint on JSONB shape — the Zod schema at the API boundary is
 * authoritative (hybrid validation principle, see #31 / ADR-021). Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    conflicts: { type: 'jsonb', notNull: true, default: '[]' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['conflicts']);
};
