import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('csi_sections', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    section_number: { type: 'varchar(20)', notNull: true, unique: true },
    title: { type: 'text', notNull: true },
    division: { type: 'varchar(2)', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('csi_sections', 'division');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('csi_sections');
};
