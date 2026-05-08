import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('specs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    section: { type: 'varchar(20)' },
    title: { type: 'text' },
    source: { type: 'varchar(20)' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    updated_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('specs');
};
