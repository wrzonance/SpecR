import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D3 — ordered per-project source list; copy-on-derive resolution
// (issue #94) walks it by priority. Plus paragraph-grain lineage: the future
// re-pull/rebase command (Phase 3 diff matches paragraphs by UUID) needs the
// clone-time paragraph mapping, which cannot be reconstructed later.
//
// Tier restriction (sources must be company|client, never reference) is
// enforced at the query layer (src/db/queries/projects.ts) — a cross-table
// CHECK on libraries.tier would require a trigger.

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('project_sources', {
    project_id: { type: 'uuid', notNull: true, references: 'projects', onDelete: 'CASCADE' },
    library_id: { type: 'uuid', notNull: true, references: 'libraries' },
    priority: { type: 'integer', notNull: true },
  });
  pgm.addConstraint(
    'project_sources',
    'project_sources_pkey',
    'PRIMARY KEY (project_id, library_id)'
  );
  pgm.addConstraint('project_sources', 'project_sources_priority_check', {
    check: 'priority >= 1',
  });
  pgm.addConstraint(
    'project_sources',
    'project_sources_project_priority_unique',
    'UNIQUE (project_id, priority)'
  );

  pgm.addColumns('paragraphs', {
    origin_paragraph_id: { type: 'uuid', references: 'paragraphs', onDelete: 'SET NULL' },
  });
  pgm.createIndex('paragraphs', 'origin_paragraph_id', {
    name: 'paragraphs_origin_idx',
    where: 'origin_paragraph_id IS NOT NULL',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('paragraphs', 'origin_paragraph_id', { name: 'paragraphs_origin_idx' });
  pgm.dropColumns('paragraphs', ['origin_paragraph_id']);
  pgm.dropTable('project_sources');
};
