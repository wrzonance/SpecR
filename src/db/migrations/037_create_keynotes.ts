import type { MigrationBuilder } from 'node-pg-migrate';

// Keynote master table (ADR-016 D1). Keynotes connect drawing annotations to
// spec content: a drawing callout carries a code; the code resolves to a CSI
// section (and optionally a specific paragraph). Masters live with libraries
// (ADR-015); a project's valid keynote set is a *filter* over these rows
// (getProjectKeynotes), never a copy — nothing to keep in sync.
//
// `code` is firm convention, opaque to SpecR — no shape CHECK (ADR-016: SpecR
// validates only uniqueness and target-section existence, never a numbering
// scheme). `target_section` mirrors specs.section (varchar(20), no regex) since
// target-section *existence* is enforced at query time by TOC membership, not by
// a DB CHECK. Non-empty guards on code/description match the paragraph_associations
// house style (migration 032) — a blank code or description is meaningless.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('keynotes', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', notNull: true, references: 'libraries', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true },
    parent_code: { type: 'text' },
    description: { type: 'text', notNull: true },
    target_section: { type: 'varchar(20)', notNull: true },
    // Optional deep link; SET NULL keeps a keynote valid (still points at its
    // section) when a regenerated spec drops the anchored paragraph.
    target_paragraph_id: { type: 'uuid', references: 'paragraphs', onDelete: 'SET NULL' },
  });

  pgm.addConstraint('keynotes', 'keynotes_library_code_unique', 'UNIQUE (library_id, code)');
  pgm.addConstraint('keynotes', 'keynotes_code_check', { check: "btrim(code) <> ''" });
  pgm.addConstraint('keynotes', 'keynotes_description_check', {
    check: "btrim(description) <> ''",
  });

  // The project filter joins on library_id (covered by the unique index's leading
  // column) and filters target_section against TOC membership.
  pgm.createIndex('keynotes', 'target_section', { name: 'keynotes_target_section_idx' });
  pgm.createIndex('keynotes', 'target_paragraph_id', {
    name: 'keynotes_target_paragraph_idx',
    where: 'target_paragraph_id IS NOT NULL',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('keynotes', { cascade: true });
};
