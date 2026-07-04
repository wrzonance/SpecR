import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-051 — style_templates join the ADR-015 library-scoped custody model (#318),
// mirroring numbering_profiles (migration 038). A nullable library_id scopes a
// template to its owning library; NULL = a built-in / global default. Existing
// rows backfill to NULL so today's global visibility (the seeded 'UFGS-Default'
// and every per-spec onboarded template) is preserved.
//
// Deliberately NO builtin-singleton unique index: unlike numbering_profiles (one
// built-in CSI Default), multiple style_templates are legitimately library_id
// NULL at once (the seeded default PLUS per-spec onboarded templates), so a
// singleton index would be violated on the first onboarding. The security fix is
// the ASSIGNMENT guard (setSpecStyleSource), not a schema-level singleton.

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('style_templates', {
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' }, // NULL = built-in / global default
  });
  // Postgres does not auto-index FK columns; scoped lookups + the assignment
  // scope predicate ((t.library_id IS NULL OR t.library_id = s.library_id)) need this.
  pgm.createIndex('style_templates', 'library_id', {
    name: 'style_templates_library_id_idx',
  });
  // Backfill is implicit: addColumns leaves every existing row's library_id NULL,
  // which is exactly the built-in/global default we want. No data statement needed.
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('style_templates', 'library_id', { name: 'style_templates_library_id_idx' });
  pgm.dropColumns('style_templates', ['library_id']);
};
