import type { MigrationBuilder } from 'node-pg-migrate';

// Division-general inheritance is structural context, not copy provenance.
// parent_spec_id remains the ADR-015 chain-of-custody edge; this table records
// one confirmed division root per library/project scope when it is explicit.

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('division_general_specs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    division: { type: 'varchar(2)', notNull: true },
    general_spec_id: { type: 'uuid', references: 'specs', onDelete: 'CASCADE' },
    status: { type: 'varchar(20)', notNull: true },
    detection_method: { type: 'varchar(30)', notNull: true },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('division_general_specs', 'division_general_specs_owner_xor', {
    check: '(library_id IS NULL) <> (project_id IS NULL)',
  });
  pgm.addConstraint('division_general_specs', 'division_general_specs_division_check', {
    check: "division ~ '^\\d{2}$'",
  });
  pgm.addConstraint('division_general_specs', 'division_general_specs_status_check', {
    check: "status IN ('resolved','not_applicable')",
  });
  pgm.addConstraint('division_general_specs', 'division_general_specs_method_check', {
    check: "detection_method IN ('exact_section','manual')",
  });
  pgm.addConstraint('division_general_specs', 'division_general_specs_status_shape_check', {
    check:
      "(status = 'resolved' AND general_spec_id IS NOT NULL) OR " +
      "(status = 'not_applicable' AND general_spec_id IS NULL)",
  });

  pgm.createIndex('division_general_specs', ['library_id', 'division'], {
    name: 'division_general_specs_library_division_unique',
    unique: true,
    where: 'library_id IS NOT NULL',
  });
  pgm.createIndex('division_general_specs', ['project_id', 'division'], {
    name: 'division_general_specs_project_division_unique',
    unique: true,
    where: 'project_id IS NOT NULL',
  });
  pgm.createIndex('division_general_specs', 'general_spec_id', {
    name: 'division_general_specs_general_spec_idx',
  });

  pgm.sql(`
    INSERT INTO division_general_specs
      (library_id, division, general_spec_id, status, detection_method)
    SELECT library_id, division, id, 'resolved', 'exact_section'
    FROM (
      SELECT DISTINCT ON (library_id, substring(section FROM 1 FOR 2))
             library_id, substring(section FROM 1 FOR 2) AS division, id
      FROM specs
      WHERE library_id IS NOT NULL
        AND section ~ '^\\d{2} 00 00$'
      ORDER BY library_id, substring(section FROM 1 FOR 2), created_at, id
    ) exact_library
  `);

  pgm.sql(`
    INSERT INTO division_general_specs
      (project_id, division, general_spec_id, status, detection_method)
    SELECT project_id, division, id, 'resolved', 'exact_section'
    FROM (
      SELECT DISTINCT ON (project_id, substring(section FROM 1 FOR 2))
             project_id, substring(section FROM 1 FOR 2) AS division, id
      FROM specs
      WHERE project_id IS NOT NULL
        AND section ~ '^\\d{2} 00 00$'
      ORDER BY project_id, substring(section FROM 1 FOR 2), created_at, id
    ) exact_project
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('division_general_specs');
};
