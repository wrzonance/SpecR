import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D1 — libraries are first-class rows; tiers are data.
// Built-in names are duplicated from src/db/queries/libraries.ts
// (UFGS_REFERENCE_LIBRARY, DEFAULT_COMPANY_LIBRARY): migrations are frozen
// snapshots and never import src/ runtime code.

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('libraries', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    tier: { type: 'varchar(20)', notNull: true },
    name: { type: 'text', notNull: true, unique: true },
    owner: { type: 'text' }, // firm/client identity; NULL for built-ins
    parent_library_id: { type: 'uuid', references: 'libraries' }, // client master → company master; nullable
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('libraries', 'libraries_tier_check', {
    check: "tier IN ('reference','company','client')",
  });

  // Built-ins: UFGS corpus stays legally separated from firm IP (ADR-012/013).
  pgm.sql(
    `INSERT INTO libraries (tier, name)
     VALUES ('reference', 'UFGS Reference'), ('company', 'Default Company Master')`
  );

  pgm.addColumns('specs', {
    library_id: { type: 'uuid', references: 'libraries' },
    project_id: { type: 'uuid', references: 'projects' },
  });

  // Backfill before the XOR constraint lands: every existing spec is a master.
  pgm.sql(
    `UPDATE specs SET library_id = (SELECT id FROM libraries WHERE name = 'UFGS Reference')
     WHERE source = 'ufgs'`
  );
  pgm.sql(
    `UPDATE specs SET library_id = (SELECT id FROM libraries WHERE name = 'Default Company Master')
     WHERE library_id IS NULL`
  );

  // A spec is a master (library_id) XOR a project working copy (project_id).
  pgm.addConstraint('specs', 'specs_owner_xor', {
    check: '(library_id IS NULL) <> (project_id IS NULL)',
  });

  // Uniqueness widens from global (section, source) to per-owner (ADR-015 D1).
  pgm.dropConstraint('specs', 'specs_section_source_unique');
  pgm.createIndex('specs', ['section', 'source', 'library_id'], {
    name: 'specs_section_source_library_unique',
    unique: true,
    where: 'library_id IS NOT NULL',
  });
  pgm.createIndex('specs', ['section', 'project_id'], {
    name: 'specs_section_project_unique',
    unique: true,
    where: 'project_id IS NOT NULL',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('specs', ['section', 'project_id'], { name: 'specs_section_project_unique' });
  pgm.dropIndex('specs', ['section', 'source', 'library_id'], {
    name: 'specs_section_source_library_unique',
  });
  // Aborts loudly if the same (section, source) now exists in two libraries —
  // by design; resolve duplicates manually before rolling back (precedent:
  // migration 013). Rollback is a dev-time operation.
  pgm.addConstraint('specs', 'specs_section_source_unique', 'UNIQUE (section, source)');
  pgm.dropConstraint('specs', 'specs_owner_xor');
  pgm.dropColumns('specs', ['library_id', 'project_id']);
  pgm.dropTable('libraries');
};
