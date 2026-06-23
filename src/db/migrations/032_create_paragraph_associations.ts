import type { MigrationBuilder } from 'node-pg-migrate';

// External content association (ADR-019 affirmed scope, #109): firms link their
// own collateral (e.g. a PDF datasheet) to a paragraph. We store the link +
// provenance only — never the licensed bytes (the DMS owns transport, ADR-014).
// Keyed on paragraph_id (the stable w:sdt UUID) so links survive regeneration.
export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('paragraph_associations', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    paragraph_id: { type: 'uuid', notNull: true, references: 'paragraphs', onDelete: 'CASCADE' },
    spec_id: { type: 'uuid', notNull: true, references: 'specs', onDelete: 'CASCADE' },
    label: { type: 'text', notNull: true },
    // ADR-014 D5 connector identity (opaque). Both present together or neither.
    external_provider: { type: 'text' },
    external_id: { type: 'text' },
    // URL + content-hash provenance for firms without a DMS connector.
    url: { type: 'text' },
    content_hash: { type: 'text' },
    external_metadata: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Identity rule (#242): the DMS pair is both-or-neither — a lone
  // external_provider or external_id is an unusable half-identity, even alongside
  // a url. AND at least one complete identity (the DMS pair or a url) is present.
  pgm.addConstraint('paragraph_associations', 'paragraph_associations_identity_check', {
    check:
      '(external_provider IS NULL) = (external_id IS NULL) ' +
      'AND ((external_provider IS NOT NULL AND external_id IS NOT NULL) OR url IS NOT NULL)',
  });
  // Label must be non-empty — a blank caption is meaningless.
  pgm.addConstraint('paragraph_associations', 'paragraph_associations_label_check', {
    check: "btrim(label) <> ''",
  });

  pgm.createIndex('paragraph_associations', 'paragraph_id', {
    name: 'paragraph_associations_paragraph_idx',
  });
  pgm.createIndex('paragraph_associations', 'spec_id', {
    name: 'paragraph_associations_spec_idx',
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('paragraph_associations', { cascade: true });
};
