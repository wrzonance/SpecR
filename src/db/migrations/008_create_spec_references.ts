import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('spec_references', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    source_spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'CASCADE' },
    source_paragraph_id: { type: 'uuid', notNull: true, references: 'paragraphs', onDelete: 'CASCADE' },
    target_type: { type: 'varchar(20)', notNull: true },
    target_spec_section: { type: 'varchar(20)' },
    target_spec_id: { type: 'uuid', references: 'specs', onDelete: 'SET NULL' },
    target_paragraph_id: { type: 'uuid', references: 'paragraphs', onDelete: 'SET NULL' },
    standard_code: { type: 'text' },
    reference_text: { type: 'text', notNull: true },
    is_broken: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('spec_references', 'source_spec_id');
  pgm.createIndex('spec_references', 'source_paragraph_id');
  pgm.createIndex('spec_references', 'target_spec_id');
  pgm.createIndex('spec_references', 'target_spec_section');
  pgm.createIndex('spec_references', ['is_broken'], { where: 'is_broken = true' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('spec_references', { cascade: true });
};
