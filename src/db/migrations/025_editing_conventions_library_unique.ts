import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * One convention profile per library (ADR-022 D3 PUT semantics).
 *
 * `upsertLibraryConvention` is the create-or-replace path for a library's own
 * profile. Without a unique key on `library_id`, two concurrent PUTs for the
 * same library could both pass a check-then-act existence probe and both
 * INSERT — surfacing as a 500 unique-violation instead of an idempotent upsert.
 *
 * This partial unique index makes `library_id` (for non-null library rows) the
 * conflict target for an atomic `INSERT ... ON CONFLICT (library_id) DO UPDATE`.
 * Built-in defaults (`library_id IS NULL`) are excluded — their singleton is
 * already enforced by `editing_conventions_builtin_singleton` (migration 024).
 */

const INDEX_NAME = 'editing_conventions_library_unique';

export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE UNIQUE INDEX ${INDEX_NAME}
    ON editing_conventions (library_id)
    WHERE library_id IS NOT NULL
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP INDEX ${INDEX_NAME}`);
};
