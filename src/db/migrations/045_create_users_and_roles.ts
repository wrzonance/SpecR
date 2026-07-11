import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-052 D6/D7 — actor identity + scoped role assignments (version-history program,
// #381). `users` is a bare identity substrate: label-claimed today (spoofable, stated
// openly), externally-associated next (Revit username mapping), SSO-verified after #43.
//
// `role_assignments` ships schema-only in this migration (#381 Wave A) — the query/REST/
// MCP layer is a same-day follow-up PR, forced by src/db/index.ts's ESLint `max-lines: 400`
// cap (confirmed via `npx eslint`, not estimated; see ADR-052 D7). Scope is stored as two
// nullable FK columns (`project_id`, `library_id`) with an XOR CHECK rather than a
// polymorphic `scope_type`/`scope_id` pair — same precedent as `division_general_specs`
// (migration 022): a real FK per scope type gets `ON DELETE CASCADE` and referential
// integrity for free. The API/MCP wire shape (`scopeType`/`scopeId`) translates to this
// storage at the query-layer boundary, not here.
//
// Migrations are frozen snapshots — this literal is duplicated here and never imported
// from src/ runtime code.
const ROLE_VALUES = ['viewer', 'editor', 'spec-editor', 'admin'] as const;
const ROLE_VALUES_SQL_LIST = ROLE_VALUES.map((role) => `'${role}'`).join(', ');

export const up = (pgm: MigrationBuilder): void => {
  createUsersTable(pgm);
  createRoleAssignmentsTable(pgm);
  addRoleAssignmentsConstraints(pgm);
  addRoleAssignmentsIndexes(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('role_assignments');
  pgm.dropTable('users');
};

function createUsersTable(pgm: MigrationBuilder): void {
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    label: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('users', 'users_label_nonempty', 'CHECK (length(trim(label)) > 0)');
  pgm.addConstraint('users', 'users_label_unique', 'UNIQUE (label)');
}

function createRoleAssignmentsTable(pgm: MigrationBuilder): void {
  pgm.createTable('role_assignments', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

function addRoleAssignmentsConstraints(pgm: MigrationBuilder): void {
  pgm.addConstraint('role_assignments', 'role_assignments_scope_xor', {
    check: '(project_id IS NULL) <> (library_id IS NULL)',
  });
  pgm.addConstraint('role_assignments', 'role_assignments_role_check', {
    check: `role IN (${ROLE_VALUES_SQL_LIST})`,
  });
}

function addRoleAssignmentsIndexes(pgm: MigrationBuilder): void {
  // Partial-unique per scope column — one role row per (user, project) or (user,
  // library); the query layer's grantRole upserts against these via ON CONFLICT so
  // re-granting replaces rather than duplicates.
  pgm.createIndex('role_assignments', ['user_id', 'project_id'], {
    name: 'role_assignments_user_project_unique',
    unique: true,
    where: 'project_id IS NOT NULL',
  });
  pgm.createIndex('role_assignments', ['user_id', 'library_id'], {
    name: 'role_assignments_user_library_unique',
    unique: true,
    where: 'library_id IS NOT NULL',
  });
  // Plain indexes for scope-side listing (all role assignments on a given project/
  // library) and user-side listing (all role assignments for a given user).
  pgm.createIndex('role_assignments', 'user_id', { name: 'role_assignments_user_id_idx' });
  pgm.createIndex('role_assignments', 'project_id', { name: 'role_assignments_project_id_idx' });
  pgm.createIndex('role_assignments', 'library_id', { name: 'role_assignments_library_id_idx' });
}
