import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-066 — persisted addendum comparison lineage. This edge is independent
// of parent_revision_id (custody): a top-level addendum may compare against an
// earlier issuance without being nested under it.
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('package_revisions', {
    base_revision_id: {
      type: 'uuid',
      references: 'package_revisions',
      onDelete: 'RESTRICT',
    },
  });
  pgm.createIndex('package_revisions', 'base_revision_id', {
    name: 'package_revisions_base_revision_id_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('package_revisions', 'base_revision_id', {
    name: 'package_revisions_base_revision_id_idx',
  });
  pgm.dropColumns('package_revisions', ['base_revision_id']);
};
