import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('projects', {
    section_number_format: {
      type: 'text',
      notNull: true,
      default: 'canonical',
    },
  });
  pgm.addConstraint('projects', 'projects_section_number_format_check', {
    check: "section_number_format IN ('canonical', 'dots', 'compact')",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('projects', 'projects_section_number_format_check');
  pgm.dropColumns('projects', ['section_number_format']);
};
