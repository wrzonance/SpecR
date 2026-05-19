import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('revit_parameter_mappings', {
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
    revit_instance_id: { type: 'text', notNull: true },
    revit_component_role: { type: 'text' },
    revit_param: { type: 'text', notNull: true },
    direction: {
      type: 'varchar(20)',
      notNull: true,
      default: 'to_spec',
      check: "direction IN ('to_spec','to_revit','bidirectional','spec_only')",
    },
    transform_type: {
      type: 'varchar(20)',
      notNull: true,
      check: "transform_type IN ('replace','placeholder','append','prepend')",
    },
    transform_config: { type: 'jsonb' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Postgres 15+ NULLS NOT DISTINCT: treat NULL revit_component_role as equal
  // so two family-instance-level mappings (NULL role) with the same instance +
  // param + paragraph collide naturally. node-pg-migrate's createTable DSL has
  // no flag for this, so we attach the unique constraint via raw SQL.
  pgm.sql(`
    ALTER TABLE revit_parameter_mappings
    ADD CONSTRAINT revit_mappings_natural_key
    UNIQUE NULLS NOT DISTINCT
      (paragraph_id, revit_instance_id, revit_component_role, revit_param)
  `);

  pgm.createIndex('revit_parameter_mappings', 'revit_instance_id', {
    name: 'revit_mappings_instance_idx',
  });
  pgm.createIndex('revit_parameter_mappings', 'paragraph_id', {
    name: 'revit_mappings_paragraph_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('revit_parameter_mappings', { cascade: true });
};
