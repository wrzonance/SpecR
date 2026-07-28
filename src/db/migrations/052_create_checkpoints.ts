import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-052 D3/D4 — checkpoints are stored named markers (the Word "accept
// changes" moment): everything after a paragraph's latest sealing checkpoint
// reads as pending; the checkpoint seals it into the reviewed baseline.
// Scope is exactly one of spec_id (single spec) or project_id (every spec in
// a project) — the same real-FK-per-scope-type XOR precedent as
// division_general_specs (migration 022) and role_assignments (migration
// 045): a real FK gets ON DELETE CASCADE and referential integrity for free,
// where a polymorphic scope_type/scope_id pair would need an
// application-level check no database constraint can enforce.
//
// content_version_map is a JSONB object of `{ [specId]: contentVersion }` —
// for a project-scoped checkpoint this snapshots every in-scope spec's
// content_version at sealing time in one row, since a single project
// checkpoint can seal many specs at once. The coalescer (issue #380) derives
// a per-spec CheckpointBoundary from this map at read time; it never reads
// specs.content_version live for a past checkpoint.
//
// user_id (the sealing actor, ADR-052 D6) is NOT NULL and ON DELETE
// RESTRICT — unlike paragraph_versions.user_id (nullable, SET NULL, because
// pre-#381 history genuinely has no actor) every checkpoint is created after
// the users table exists, so attribution is mandatory and a user with
// checkpoints attributed to them cannot be deleted out from under the audit
// trail.
export const up = (pgm: MigrationBuilder): void => {
  createCheckpointsTable(pgm);
  addCheckpointsConstraints(pgm);
  addCheckpointsIndexes(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('checkpoints');
};

function createCheckpointsTable(pgm: MigrationBuilder): void {
  pgm.createTable('checkpoints', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    spec_id: { type: 'uuid', references: 'specs', onDelete: 'CASCADE' },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'RESTRICT' },
    content_version_map: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

function addCheckpointsConstraints(pgm: MigrationBuilder): void {
  pgm.addConstraint('checkpoints', 'checkpoints_scope_xor', {
    check: '(spec_id IS NULL) <> (project_id IS NULL)',
  });
  pgm.addConstraint('checkpoints', 'checkpoints_name_nonempty', {
    check: 'length(trim(name)) > 0',
  });
  pgm.addConstraint('checkpoints', 'checkpoints_content_version_map_object', {
    check: "jsonb_typeof(content_version_map) = 'object'",
  });
}

function addCheckpointsIndexes(pgm: MigrationBuilder): void {
  // Partial per-scope indexes for "latest checkpoint for this spec/project" reads —
  // mirrors division_general_specs' per-scope-column partial index precedent.
  pgm.createIndex('checkpoints', ['spec_id', 'created_at'], {
    name: 'checkpoints_spec_created_at_idx',
    where: 'spec_id IS NOT NULL',
  });
  pgm.createIndex('checkpoints', ['project_id', 'created_at'], {
    name: 'checkpoints_project_created_at_idx',
    where: 'project_id IS NOT NULL',
  });
  pgm.createIndex('checkpoints', 'user_id', { name: 'checkpoints_user_id_idx' });
}
