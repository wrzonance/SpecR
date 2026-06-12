import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D5 — package revisions: immutable issuance snapshots. Each
// issuance ('50% DD', '100% CD', 'Addendum 2') freezes the full SpecTree of
// every member section as lossless JSONB, so "what we issued" is
// reproducible forever regardless of later edits.
//
// package_revision_specs.spec_id keeps the FK default (NO ACTION) exactly
// as ADR-015 D5 specifies: the check runs at end of statement, so a
// project delete (whose cascade removes the design_packages → revisions →
// snapshot rows AND the project's spec clones in one statement) succeeds,
// while an ad-hoc delete of a spec that appears in an issued revision is
// blocked — chain of custody survives TOC churn.
//
// The lifecycle_state='issued' hook is deliberately absent — deferred to
// the document-concurrency work (ADR-018).

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('package_revisions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    package_id: {
      type: 'uuid',
      notNull: true,
      references: 'design_packages',
      onDelete: 'CASCADE',
    },
    label: { type: 'text', notNull: true },
    issued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'package_revisions',
    'package_revisions_package_label_unique',
    'UNIQUE (package_id, label)'
  );

  pgm.createTable('package_revision_specs', {
    revision_id: {
      type: 'uuid',
      notNull: true,
      references: 'package_revisions',
      onDelete: 'CASCADE',
    },
    spec_id: { type: 'uuid', notNull: true, references: 'specs' },
    position: { type: 'integer', notNull: true },
    tree: { type: 'jsonb', notNull: true },
  });
  pgm.addConstraint(
    'package_revision_specs',
    'package_revision_specs_pkey',
    'PRIMARY KEY (revision_id, spec_id)'
  );
  pgm.addConstraint('package_revision_specs', 'package_revision_specs_position_check', {
    check: 'position >= 1',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('package_revision_specs');
  pgm.dropTable('package_revisions');
};
