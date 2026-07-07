import type { MigrationBuilder } from 'node-pg-migrate';

// First-class client organizational entity (ADR-054, lifts the ADR-025 deferral).
// A client is a LINK, not a merge: library_id optionally points at the client's
// client-tier master library (ON DELETE SET NULL — an optional cross-reference, so
// the client stays valid without its library, matching spec_references.target_spec_id).
// projects.client_id is ON DELETE RESTRICT — a client with projects cannot be
// hard-deleted; disassociate first (fail loud), matching the meaningful-association
// FK precedent (project_specs.spec_id, specs.style_source). name is UNIQUE + non-empty.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('clients', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('clients', 'clients_name_unique', 'UNIQUE (name)');
  pgm.addConstraint('clients', 'clients_name_nonempty', 'CHECK (length(trim(name)) > 0)');

  pgm.addColumns('projects', {
    client_id: { type: 'uuid', references: 'clients', onDelete: 'RESTRICT' },
  });
  pgm.createIndex('projects', 'client_id', { name: 'projects_client_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('projects', 'client_id', { name: 'projects_client_id_idx' });
  pgm.dropColumns('projects', ['client_id']);
  pgm.dropTable('clients', { cascade: true });
};
