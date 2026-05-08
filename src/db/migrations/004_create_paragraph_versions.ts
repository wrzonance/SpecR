import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('paragraph_versions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    paragraph_id: {
      type: 'uuid',
      notNull: true,
      references: 'paragraphs',
      onDelete: 'CASCADE',
    },
    version: { type: 'integer', notNull: true },
    text: { type: 'text', notNull: true },
    node_type: { type: 'varchar(20)', notNull: true },
    snapshot_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('paragraph_versions', ['paragraph_id', 'version'], { unique: true });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('paragraph_versions', { cascade: true });
};
