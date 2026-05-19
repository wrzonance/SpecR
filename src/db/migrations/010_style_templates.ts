import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('style_templates', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    owner: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable('style_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    template_id: {
      type: 'uuid',
      notNull: true,
      references: 'style_templates',
      onDelete: 'CASCADE',
    },
    // 'part' | 'article' | 'pr1' | 'pr2' | 'pr3' | 'pr4' | 'pr5'
    node_type: { type: 'varchar(20)', notNull: true },
    font_family: { type: 'text' },
    // OOXML native unit: half-points (20 = 10pt)
    font_size_half_pt: { type: 'integer' },
    bold: { type: 'boolean', notNull: true, default: false },
    caps: { type: 'boolean', notNull: true, default: false },
    // OOXML native unit: twips (1440 twips = 1 inch)
    indent_twips: { type: 'integer' },
    space_before_twips: { type: 'integer' },
    space_after_twips: { type: 'integer' },
    numbering_format: { type: 'text' },
  });

  pgm.addConstraint('style_rules', 'style_rules_template_node_type_key', {
    unique: ['template_id', 'node_type'],
  });
  // Enforce the StyleNodeType domain at the DB boundary — mirrors the TS union
  // exported from src/db/queries/templates.ts. Keep the two in sync.
  pgm.addConstraint('style_rules', 'style_rules_node_type_check', {
    check: `node_type IN ('part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5')`,
  });
  // OOXML units are unsigned by definition: half-points and twips cannot be negative.
  // Defends against bad data from future template imports / API writes.
  pgm.addConstraint('style_rules', 'style_rules_non_negative_ooxml_units_check', {
    check: `
      (font_size_half_pt IS NULL OR font_size_half_pt >= 0) AND
      (indent_twips IS NULL OR indent_twips >= 0) AND
      (space_before_twips IS NULL OR space_before_twips >= 0) AND
      (space_after_twips IS NULL OR space_after_twips >= 0)
    `,
  });
  pgm.createIndex('style_rules', 'template_id', { name: 'style_rules_template_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('style_rules', { cascade: true });
  pgm.dropTable('style_templates', { cascade: true });
};
