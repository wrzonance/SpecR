import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D4 — design packages: named, ordered, issuable subsets of the
// project TOC. A project issues multiple packages (bid packages, early
// releases, CD sets); one spec may belong to several packages.
// package_specs.spec_id is RESTRICT: a spec cannot be deleted out from under
// a package — remove it from its packages (or delete the package) first.
//
// Same-project membership (a package may only hold specs from its own
// project's TOC) is enforced at the query layer
// (src/db/queries/packages.ts) — a cross-table CHECK against
// design_packages.project_id would require a trigger (same pattern as the
// project_sources tier restriction, migration 018).

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('design_packages', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    position: { type: 'integer', notNull: true },
  });
  pgm.addConstraint(
    'design_packages',
    'design_packages_project_name_unique',
    'UNIQUE (project_id, name)'
  );
  pgm.addConstraint('design_packages', 'design_packages_position_check', {
    check: 'position >= 1',
  });

  pgm.createTable('package_specs', {
    package_id: {
      type: 'uuid',
      notNull: true,
      references: 'design_packages',
      onDelete: 'CASCADE',
    },
    spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'RESTRICT' },
    position: { type: 'integer', notNull: true },
  });
  pgm.addConstraint('package_specs', 'package_specs_pkey', 'PRIMARY KEY (package_id, spec_id)');
  pgm.addConstraint('package_specs', 'package_specs_position_check', {
    check: 'position >= 1',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('package_specs');
  pgm.dropTable('design_packages');
};
