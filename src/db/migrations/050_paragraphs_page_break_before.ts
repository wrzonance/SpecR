import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #497, ADR-075: persist a manual page break (`meta.pageBreakBefore`) so it
 * survives the real upload → parse → PERSIST → generate flow, not only the
 * in-memory parser→generator path. The flag is a paragraph-level boolean with
 * exactly the shape and lifecycle of `vanish` (migration 003), so it gets its
 * own dedicated column rather than riding a JSONB blob — `paragraphs` has no
 * catch-all `meta` column; every `meta.*` field maps to an explicit column
 * (`vanish`, `conflicts`, `source_facts`, `signal_provenance`, `object_data`)
 * written and reconstructed by name. Absent/false === no manual page break;
 * never backfilled on rows parsed before this column existed. Reversible.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    page_break_before: { type: 'boolean', notNull: true, default: false },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['page_break_before']);
};
