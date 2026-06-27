import type { MigrationBuilder } from 'node-pg-migrate';

// Spec soft-delete / withdraw (ADR-030): deleting a library master is a
// reversible tombstone, not a destructive row delete. ADR-015's layered-spec
// chain-of-custody means hard-deleting a master would destroy the provenance of
// every derived project copy — so DELETE /specs/:id sets withdrawn_at instead.
//   withdrawn_at  NULL = active; set to now() on withdraw, cleared on restore.
// Withdrawal targets library masters (library_id set); project copies use the
// existing DELETE /projects/:id/specs/:specId membership endpoint. No change to
// parent_spec_id onDelete — lineage edges stay intact.
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    withdrawn_at: { type: 'timestamptz' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('specs', ['withdrawn_at']);
};
