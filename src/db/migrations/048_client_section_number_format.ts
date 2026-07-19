import type { MigrationBuilder } from 'node-pg-migrate';

const FORMAT_CHECK = "section_number_format IN ('canonical', 'dots', 'compact', 'spaced-compact')";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn('clients', {
    section_number_format: { type: 'text', notNull: true, default: 'canonical' },
  });
  pgm.addConstraint('clients', 'clients_section_number_format_check', {
    check: FORMAT_CHECK,
  });

  // Existing project values remain explicit overrides. New projects inherit
  // from their client because the project column now defaults to NULL.
  pgm.alterColumn('projects', 'section_number_format', { notNull: false, default: null });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(
    `UPDATE projects SET section_number_format = 'canonical' WHERE section_number_format IS NULL`
  );
  pgm.alterColumn('projects', 'section_number_format', {
    notNull: true,
    default: 'canonical',
  });
  pgm.dropConstraint('clients', 'clients_section_number_format_check');
  pgm.dropColumn('clients', 'section_number_format');
};
