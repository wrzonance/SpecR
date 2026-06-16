import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-018 — native document concurrency + state model. Three small mechanisms,
// not one big lock:
//
//   D2  spec_locks       — advisory soft locks with TTL (steal-after-expiry,
//                          no unlock ceremony). holder is a caller label until
//                          auth (#43) lands.
//   D3  lifecycle_state  — closed { draft | issued | archived }. 'issued' is set
//                          automatically when a package revision is created
//                          (ADR-015 D5 hook, deferred from migration 021 to here).
//                          'archived' is read-only.
//   D3  external_state   — the single generic field ADR-014 D5's edit gate reads.
//                          The full external_* linkage + the connector that
//                          POPULATES it remain Phase 7 (ADR-014); the gate here
//                          only READS this column, so core stays DMS-agnostic in
//                          behavior. Default 'editable' so existing specs are
//                          writable. Closed enum — provider specifics live in
//                          external_metadata (Phase 7), never as new enum values.
//
// D1 (optimistic concurrency) needs no schema: it reuses specs.content_version
// (migration 017, ADR-015) as the precondition token.

const LIFECYCLE_STATES = "('draft','issued','archived')";
const EXTERNAL_STATES = "('editable','locked','pending-review','retained','read-only')";

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    lifecycle_state: { type: 'text', notNull: true, default: 'draft' },
    external_state: { type: 'text', notNull: true, default: 'editable' },
  });
  pgm.addConstraint('specs', 'specs_lifecycle_state_check', {
    check: `lifecycle_state IN ${LIFECYCLE_STATES}`,
  });
  pgm.addConstraint('specs', 'specs_external_state_check', {
    check: `external_state IN ${EXTERNAL_STATES}`,
  });

  pgm.createTable('spec_locks', {
    spec_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'specs',
      onDelete: 'CASCADE',
    },
    holder: { type: 'text', notNull: true },
    acquired_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('spec_locks');
  pgm.dropConstraint('specs', 'specs_external_state_check');
  pgm.dropConstraint('specs', 'specs_lifecycle_state_check');
  pgm.dropColumns('specs', ['lifecycle_state', 'external_state']);
};
