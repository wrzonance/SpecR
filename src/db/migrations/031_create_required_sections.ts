import type { MigrationBuilder } from 'node-pg-migrate';

// Authored coordination intent (ADR-028). Unlike project_specs/package_specs,
// this names sections by NUMBER and may include sections with no derived spec
// document yet. Expanded CSI shape (ADR-020), mirroring migration 013's gate.
const SECTION_SHAPE = String.raw`^\d{2} \d{2} \d{2}(\.\d{2}( \d{2})?)?$`;

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('required_sections', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    package_id: { type: 'uuid', references: 'design_packages', onDelete: 'CASCADE' },
    section: { type: 'text', notNull: true },
    title: { type: 'text' },
    position: { type: 'integer', notNull: true },
  });

  pgm.addConstraint('required_sections', 'required_sections_position_check', {
    check: 'position >= 1',
  });
  pgm.addConstraint('required_sections', 'required_sections_section_shape_check', {
    check: `section ~ '${SECTION_SHAPE}'`,
  });

  pgm.createIndex('required_sections', ['project_id', 'section'], {
    name: 'required_sections_project_section_unique',
    unique: true,
    where: 'package_id IS NULL',
  });
  pgm.createIndex('required_sections', ['project_id', 'package_id', 'section'], {
    name: 'required_sections_project_package_section_unique',
    unique: true,
    where: 'package_id IS NOT NULL',
  });
  pgm.createIndex('required_sections', ['project_id', 'package_id'], {
    name: 'required_sections_scope_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('required_sections', { cascade: true });
};
