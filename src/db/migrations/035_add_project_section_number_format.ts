import type { MigrationBuilder } from 'node-pg-migrate';

// Persist a project-default section-number display format. When a generate
// request omits an explicit format, the handler will fall back to this value.
// The CHECK keeps the column in sync with SectionNumberFormat in section-number.ts.
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumn('projects', {
    section_number_format: {
      type: 'text',
      notNull: true,
      default: 'canonical',
    },
  });
  pgm.addConstraint(
    'projects',
    'projects_section_number_format_check',
    `CHECK (section_number_format IN ('canonical', 'dots', 'compact', 'spaced-compact'))`
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('projects', 'projects_section_number_format_check');
  pgm.dropColumn('projects', 'section_number_format');
};
