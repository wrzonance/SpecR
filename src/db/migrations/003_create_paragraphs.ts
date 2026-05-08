import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('paragraphs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    spec_id: {
      type: 'uuid',
      notNull: true,
      references: 'specs',
      onDelete: 'CASCADE',
    },
    parent_id: { type: 'uuid', references: 'paragraphs' },
    node_type: { type: 'varchar(20)', notNull: true },
    text: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
    vanish: { type: 'boolean', notNull: true, default: false },
    revit_param: { type: 'text' },
    base_version: { type: 'integer', notNull: true, default: 1 },
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
  pgm.createIndex('paragraphs', 'spec_id');
  pgm.createIndex('paragraphs', 'parent_id');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('paragraphs');
};
