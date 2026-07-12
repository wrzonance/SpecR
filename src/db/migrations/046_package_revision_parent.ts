import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-066 — package revision custody. Adds parent_revision_id: the revision
// this one was issued FROM (git-tag-like lineage, distinct from #390's future
// base_revision_id comparison-lineage edge on the same table). NULL = a root
// revision with no known predecessor.
//
// ON DELETE RESTRICT, deliberately not SET NULL/CASCADE: a revision is an
// immutable issuance snapshot (ADR-015 D5), so its parent can never be
// silently detached or dragged into a delete cascade — no delete surface
// exists for package_revisions today, so this is a tripwire against one
// being added carelessly later.
//
// No CHECK against self-reference (id <> parent_revision_id): it is
// structurally unreachable rather than merely inconvenient. id defaults to
// gen_random_uuid() and is never client-supplied, so no caller can know a
// revision's own id before it exists; the query layer (src/db/queries/
// revision-parent.ts) also validates the parent BEFORE the INSERT that
// creates the child row, so the child can never appear as its own candidate.
// A DB CHECK would guard a state the call path cannot produce.
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('package_revisions', {
    parent_revision_id: {
      type: 'uuid',
      references: 'package_revisions',
      onDelete: 'RESTRICT',
    },
  });
  // Postgres does not auto-index FK columns; the RESTRICT reference-count
  // pre-check and "what was issued from this revision" lookups need this.
  pgm.createIndex('package_revisions', 'parent_revision_id', {
    name: 'package_revisions_parent_revision_id_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('package_revisions', 'parent_revision_id', {
    name: 'package_revisions_parent_revision_id_idx',
  });
  pgm.dropColumns('package_revisions', ['parent_revision_id']);
};
