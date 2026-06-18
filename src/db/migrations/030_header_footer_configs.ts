import type { MigrationBuilder } from 'node-pg-migrate';

// Issue #208 — backend foundation for running header/footer composition.
// Rows are scoped to exactly one layer in the resolution chain:
// client library → project → package → revision. Rendering is deliberately
// out of scope; config stays as open JSONB validated at the query boundary.

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('header_footer_configs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    client_library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    package_id: { type: 'uuid', references: 'design_packages', onDelete: 'CASCADE' },
    revision_id: { type: 'uuid', references: 'package_revisions', onDelete: 'CASCADE' },
    config: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('header_footer_configs', 'header_footer_configs_scope_xor', {
    check: 'num_nonnulls(client_library_id, project_id, package_id, revision_id) = 1',
  });
  pgm.addConstraint('header_footer_configs', 'header_footer_configs_config_object', {
    check: "jsonb_typeof(config) = 'object'",
  });

  pgm.sql(`
    CREATE UNIQUE INDEX header_footer_configs_client_unique
    ON header_footer_configs (client_library_id)
    WHERE client_library_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX header_footer_configs_project_unique
    ON header_footer_configs (project_id)
    WHERE project_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX header_footer_configs_package_unique
    ON header_footer_configs (package_id)
    WHERE package_id IS NOT NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX header_footer_configs_revision_unique
    ON header_footer_configs (revision_id)
    WHERE revision_id IS NOT NULL
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('header_footer_configs', ['revision_id'], {
    name: 'header_footer_configs_revision_unique',
  });
  pgm.dropIndex('header_footer_configs', ['package_id'], {
    name: 'header_footer_configs_package_unique',
  });
  pgm.dropIndex('header_footer_configs', ['project_id'], {
    name: 'header_footer_configs_project_unique',
  });
  pgm.dropIndex('header_footer_configs', ['client_library_id'], {
    name: 'header_footer_configs_client_unique',
  });
  pgm.dropTable('header_footer_configs');
};
