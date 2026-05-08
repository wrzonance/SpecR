import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.addConstraint('specs', 'specs_section_source_unique', 'UNIQUE (section, source)');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('specs', 'specs_section_source_unique');
};
