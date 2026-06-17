import type { MigrationBuilder } from 'node-pg-migrate';

// Issue #138 (O-12) — manual style-source pick (first slice of #125).
// Nullable FK from a spec to the style_templates row that supplies its house
// style. NULL = "no style source yet" (an honest, flaggable state — never
// auto-nulled). ON DELETE RESTRICT, deliberately not SET NULL: a spec must
// never silently lose its formatting because a template was deleted, so a
// referenced template cannot be deleted (the 409 enforcement lives in the
// delete-template path). The column is forward-compatible with the future
// resolution chain spec.style_template_id ?? project.style_template_id ?? default.

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    style_template_id: {
      type: 'uuid',
      references: 'style_templates',
      onDelete: 'RESTRICT',
    },
  });
  // Postgres does not auto-index FK columns; the RESTRICT reference-count
  // pre-check and any "which specs use this template" lookups need this.
  pgm.createIndex('specs', 'style_template_id', { name: 'specs_style_template_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('specs', 'style_template_id', { name: 'specs_style_template_id_idx' });
  pgm.dropColumns('specs', ['style_template_id']);
};
