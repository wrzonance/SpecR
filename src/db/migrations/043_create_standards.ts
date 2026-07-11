import type { MigrationBuilder } from 'node-pg-migrate';

// Standards registry (#446, ADR-064): the cited standard as a first-class record.
// Global, not scope-owned — one row per real-world standard, keyed on
// (org_code, standard_code) and shared across every library/project that cites it.
// Citations stay in spec_references; this registry stores only the verdict a
// reviewing client records (status, current version, source, last_verified_at).
// status is a CHECK-constrained enum defaulting to 'unknown'. org_code is stored
// uppercased by the write path (see parseStandardCitation); the unique key makes
// the rollup's LEFT JOIN from a cited standard to its verdict deterministic.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('standards', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    org_code: { type: 'text', notNull: true },
    standard_code: { type: 'text', notNull: true },
    title: { type: 'text' },
    current_version: { type: 'text' },
    source_url: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'unknown' },
    last_verified_at: { type: 'timestamptz' },
    notes: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'standards',
    'standards_org_standard_unique',
    'UNIQUE (org_code, standard_code)'
  );
  pgm.addConstraint(
    'standards',
    'standards_status_check',
    "CHECK (status IN ('current', 'superseded', 'withdrawn', 'unknown'))"
  );
  pgm.addConstraint(
    'standards',
    'standards_org_code_nonempty',
    'CHECK (length(trim(org_code)) > 0)'
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('standards', { cascade: true });
};
