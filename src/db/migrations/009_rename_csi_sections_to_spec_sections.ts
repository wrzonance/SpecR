import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.renameTable('csi_sections', 'spec_sections');
  pgm.sql('ALTER INDEX csi_sections_division_index RENAME TO spec_sections_division_index');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql('ALTER INDEX spec_sections_division_index RENAME TO csi_sections_division_index');
  pgm.renameTable('spec_sections', 'csi_sections');
};
