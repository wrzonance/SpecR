import type { MigrationBuilder } from 'node-pg-migrate';

// Project soft-delete (ADR-031, mirrors ADR-030's spec withdraw philosophy):
// deleting a project is a reversible tombstone, not a destructive row delete —
// custody/provenance of every derived copy is preserved and the action is
// undoable via POST /projects/:id/restore.
//   deleted_at  NULL = active; set to now() on soft-delete.
//   deleted_by  free-text actor (no FK — no user/auth model yet, #43 deferred).
//               When auth lands it will be populated from the session.
export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('projects', {
    deleted_at: { type: 'timestamptz' },
    deleted_by: { type: 'text' },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropColumns('projects', ['deleted_at', 'deleted_by']);
};
