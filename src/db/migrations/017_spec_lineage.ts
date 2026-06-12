import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 D2 — copy-on-derive lineage + drift baseline + ingest provenance.
// parent_spec_id/origin_version are written by clone paths (issue #94);
// this migration only creates them. content_version bumps on content writes
// (persistParsedSpec upsert, updateSpec). origin_meta records ingest
// provenance: { filename, sha256, loader }.

export const up = (pgm: MigrationBuilder): void => {
  pgm.addColumns('specs', {
    parent_spec_id: { type: 'uuid', references: 'specs' }, // derivation edge
    origin_version: { type: 'integer' }, // parent content_version at clone time
    content_version: { type: 'integer', notNull: true, default: 1 },
    origin_meta: { type: 'jsonb' },
  });
  // Postgres does not auto-index FK columns; lineage reverse lookups
  // ("what derives from this spec") and FK delete checks need this.
  pgm.createIndex('specs', 'parent_spec_id', { name: 'specs_parent_spec_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('specs', 'parent_spec_id', { name: 'specs_parent_spec_id_idx' });
  pgm.dropColumns('specs', ['parent_spec_id', 'origin_version', 'content_version', 'origin_meta']);
};
