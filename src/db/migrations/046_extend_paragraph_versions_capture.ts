import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-052 D1 — paragraph_versions capture extension (issue #377). Extends the
// bare (paragraph_id, version, text, node_type) snapshot row from migration 004
// with enough context that a version row is self-describing without joining
// back through paragraphs/specs: which spec it belongs to, what kind of write
// produced it, which content_version generation it belonged to, who did it,
// and (for structural ops) a small payload describing the delta.
//
// spec_id is backfilled from paragraphs — a stable, lossless JOIN, since every
// paragraph_versions row's paragraph_id references a live paragraph (ON DELETE
// CASCADE from migration 004 means an orphan can't exist) — then tightened to
// NOT NULL. op is backfilled via a column DEFAULT ('merge': the only writer in
// existence before this issue was snapshotParagraphVersion, called exclusively
// from merge/conflict.ts), then the default is dropped so every future INSERT
// must state its op explicitly. content_version, user_id, and payload are
// genuinely unrecoverable for historical rows and are left NULL — no invented
// backfill (CLAUDE.md's OOXML/data-ambiguity rule: never silently pick a value).
//
// Migrations are frozen snapshots — OPS is a literal duplicated here, not
// imported from src/ runtime code, and must stay in lockstep with
// src/db/queries/paragraph-history.ts's PARAGRAPH_HISTORY_OPS.
const OPS = ['edit', 'insert', 'remove', 'restore', 'merge', 'accept-note', 'restructure'] as const;
const OPS_SQL_LIST = OPS.map((op) => `'${op}'`).join(', ');

const CAPTURE_COLUMNS = ['spec_id', 'op', 'content_version', 'user_id', 'payload'] as const;
const INDEX_NAME = 'paragraph_versions_spec_content_version_idx';

function addCaptureColumns(pgm: MigrationBuilder): void {
  pgm.addColumns('paragraph_versions', {
    spec_id: { type: 'uuid', references: 'specs', onDelete: 'CASCADE' },
    op: { type: 'text', notNull: true, default: 'merge' },
    content_version: { type: 'integer' },
    user_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    payload: { type: 'jsonb' },
  });
}

function backfillSpecId(pgm: MigrationBuilder): void {
  // Every paragraph_versions row's paragraph_id points at a live paragraph
  // (ON DELETE CASCADE, migration 004) — this join always finds one.
  pgm.sql(`
    UPDATE paragraph_versions v
    SET spec_id = p.spec_id
    FROM paragraphs p
    WHERE v.paragraph_id = p.id
  `);
}

function tightenCaptureColumns(pgm: MigrationBuilder): void {
  pgm.alterColumn('paragraph_versions', 'spec_id', { notNull: true });
  pgm.alterColumn('paragraph_versions', 'op', { default: null }); // DROP DEFAULT, post-backfill
  pgm.addConstraint('paragraph_versions', 'paragraph_versions_op_check', {
    check: `op IN (${OPS_SQL_LIST})`,
  });
}

export const up = (pgm: MigrationBuilder): void => {
  addCaptureColumns(pgm);
  backfillSpecId(pgm);
  tightenCaptureColumns(pgm);
  pgm.createIndex('paragraph_versions', ['spec_id', 'content_version'], { name: INDEX_NAME });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('paragraph_versions', ['spec_id', 'content_version'], { name: INDEX_NAME });
  pgm.dropColumns('paragraph_versions', [...CAPTURE_COLUMNS]);
};
