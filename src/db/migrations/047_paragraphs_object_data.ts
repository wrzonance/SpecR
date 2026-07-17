import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #300, ADR-072: persist captured body objects (table / text box) on the
 * owning `object` paragraph as an opaque round-trip blob. Wire shape mirrors
 * `ObjectMetaSchema` (src/ast/object-schemas.ts): { kind, floating,
 * generation, rows?, columns?, blob }. NULL on every non-`object` row and on
 * any row parsed before this column existed — never backfilled, never a
 * fabricated value (CLAUDE.md's OOXML-ambiguity rule). No CHECK on JSONB
 * shape — the Zod schema at the query boundary is authoritative (hybrid
 * validation, ADR-021), same precedent as `signal_provenance` (migration
 * 041). Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    object_data: { type: 'jsonb' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['object_data']);
};
