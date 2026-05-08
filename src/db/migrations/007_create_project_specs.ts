import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('project_specs', {
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'RESTRICT' },
    position: { type: 'integer', notNull: true },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('project_specs', 'project_specs_pkey', 'PRIMARY KEY (project_id, spec_id)');
  pgm.createIndex('project_specs', 'spec_id');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('project_specs', { cascade: true });
};
