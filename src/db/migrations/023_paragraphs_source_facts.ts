import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * #131: persist parser source facts per paragraph.
 * Shape is validated by SourceFactsSchema; JSONB stays open to preserve
 * unknown future fact keys. Empty facts are stored as {} and omitted at read
 * boundaries.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('paragraphs', {
    source_facts: { type: 'jsonb', notNull: true, default: '{}' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('paragraphs', ['source_facts']);
};
