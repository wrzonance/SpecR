import type { MigrationBuilder } from 'node-pg-migrate';

// Issue #209 / ADR-025 — revision nomenclature is scoped user data. The
// profile owns the runtime taxonomy and templates; package_revisions keeps a
// thin queryable spine plus open JSONB attributes.

const DEFAULT_TYPES = [
  {
    key: 'issuance',
    name: 'Milestone Issuance',
    format: { displayName: '{phase}', number: '{phase}' },
    fields: [
      { key: 'phase', kind: 'string', required: true },
      { key: 'title', kind: 'string' },
    ],
  },
  {
    key: 'addendum',
    name: 'Addendum',
    format: { displayName: 'Addendum {number}', number: '{number}' },
    fields: [
      { key: 'number', kind: 'integer', required: true, sequence: 'per-package' },
      { key: 'title', kind: 'string' },
    ],
  },
  {
    key: 'bulletin',
    name: 'Bulletin',
    format: { displayName: 'Bulletin {number}', number: '{number}' },
    fields: [
      { key: 'number', kind: 'integer', required: true, sequence: 'per-package' },
      { key: 'title', kind: 'string' },
    ],
  },
  {
    key: 'ccd',
    name: 'CCD',
    format: { displayName: 'CCD {number}', number: '{number}' },
    fields: [
      { key: 'number', kind: 'integer', required: true, sequence: 'per-package' },
      { key: 'title', kind: 'string' },
    ],
  },
];

const escapedJson = (value: unknown): string => JSON.stringify(value).replace(/'/g, "''");

function createProfileTable(pgm: MigrationBuilder): void {
  pgm.createTable('revision_nomenclature_profiles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    types: { type: 'jsonb', notNull: true, default: '[]' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.sql(`
    CREATE UNIQUE INDEX revision_nomenclature_builtin_singleton
    ON revision_nomenclature_profiles ((project_id IS NULL))
    WHERE project_id IS NULL
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX revision_nomenclature_project_unique
    ON revision_nomenclature_profiles (project_id)
    WHERE project_id IS NOT NULL
  `);
  pgm.addConstraint('revision_nomenclature_profiles', 'revision_nomenclature_types_array', {
    check: "jsonb_typeof(types) = 'array'",
  });
  pgm.sql(
    `INSERT INTO revision_nomenclature_profiles (project_id, name, types)
     VALUES (NULL, 'SpecR Default Revision Nomenclature', '${escapedJson(DEFAULT_TYPES)}'::jsonb)`
  );
}

function addRevisionSpineColumns(pgm: MigrationBuilder): void {
  pgm.addColumns('package_revisions', {
    revision_type: { type: 'text' },
    revision_date: { type: 'date' },
    sort_order: { type: 'integer' },
    attributes: { type: 'jsonb', notNull: true, default: '{}' },
  });
  pgm.sql(`
    WITH numbered AS (
      SELECT id, label, issued_at::date AS issued_date,
             row_number() OVER (PARTITION BY package_id ORDER BY issued_at, id)::integer AS rn
      FROM package_revisions
    ),
    derived AS (
      SELECT id, issued_date, rn,
        CASE
          WHEN label ~* '^\\s*addendum\\s+[0-9]+\\s*$' THEN 'addendum'
          WHEN label ~* '^\\s*bulletin\\s+[0-9]+\\s*$' THEN 'bulletin'
          WHEN label ~* '^\\s*ccd\\s+[0-9]+\\s*$' THEN 'ccd'
          ELSE 'issuance'
        END AS revision_type,
        CASE
          WHEN label ~* '^\\s*(addendum|bulletin|ccd)\\s+[0-9]+\\s*$'
          THEN jsonb_build_object('number', substring(label FROM '([0-9]+)\\s*$')::integer)
          ELSE jsonb_build_object('title', label)
        END AS attributes
      FROM numbered
    )
    UPDATE package_revisions pr
    SET revision_type = d.revision_type,
        revision_date = d.issued_date,
        sort_order = d.rn,
        attributes = d.attributes
    FROM derived d
    WHERE pr.id = d.id
  `);
}

function constrainRevisionSpine(pgm: MigrationBuilder): void {
  pgm.alterColumn('package_revisions', 'revision_type', { notNull: true });
  pgm.alterColumn('package_revisions', 'revision_date', { notNull: true });
  pgm.alterColumn('package_revisions', 'sort_order', { notNull: true });
  pgm.addConstraint('package_revisions', 'package_revisions_type_nonempty', {
    check: 'length(btrim(revision_type)) > 0',
  });
  pgm.addConstraint('package_revisions', 'package_revisions_revision_date_check', {
    check: 'revision_date IS NOT NULL',
  });
  pgm.addConstraint('package_revisions', 'package_revisions_sort_order_check', {
    check: 'sort_order >= 1',
  });
  pgm.addConstraint('package_revisions', 'package_revisions_attributes_object', {
    check: "jsonb_typeof(attributes) = 'object'",
  });
  pgm.addConstraint(
    'package_revisions',
    'package_revisions_package_sort_order_unique',
    'UNIQUE (package_id, sort_order)'
  );
  pgm.createIndex('package_revisions', ['package_id', 'revision_type'], {
    name: 'package_revisions_package_type_idx',
  });
}

export const up = (pgm: MigrationBuilder): void => {
  createProfileTable(pgm);
  addRevisionSpineColumns(pgm);
  constrainRevisionSpine(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('package_revisions', ['package_id', 'revision_type'], {
    name: 'package_revisions_package_type_idx',
  });
  pgm.dropConstraint('package_revisions', 'package_revisions_package_sort_order_unique');
  pgm.dropConstraint('package_revisions', 'package_revisions_attributes_object');
  pgm.dropConstraint('package_revisions', 'package_revisions_sort_order_check');
  pgm.dropConstraint('package_revisions', 'package_revisions_revision_date_check');
  pgm.dropConstraint('package_revisions', 'package_revisions_type_nonempty');
  pgm.dropColumns('package_revisions', [
    'revision_type',
    'revision_date',
    'sort_order',
    'attributes',
  ]);
  pgm.dropTable('revision_nomenclature_profiles');
};
