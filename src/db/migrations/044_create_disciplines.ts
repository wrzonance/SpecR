import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-065 — discipline mapping (scoped-profile pattern, mirrors editing_conventions #137
// and numbering_profiles #299). `disciplines` is a GLOBAL catalog; `discipline_section_rules`
// maps an inclusive CSI division range to a discipline, scoped per library. Rows with
// `library_id IS NULL` are the built-in default that resolves when a library has no rules
// of its own. Migrations are frozen snapshots — these literals are duplicated here and are
// never imported from src/ runtime code.

// Global discipline catalog. `key` is the stable API/filter slug; `name` is the display
// label. "Mechanical" is seeded but unmapped by the default rules — it exists as an override
// target for firms that group all mechanical trades (21–23) under one discipline (ADR-065).
const DISCIPLINES: readonly { key: string; name: string }[] = [
  { key: 'fire-suppression', name: 'Fire Suppression' },
  { key: 'plumbing', name: 'Plumbing' },
  { key: 'hvac', name: 'HVAC' },
  { key: 'mechanical', name: 'Mechanical' },
  { key: 'integrated-automation', name: 'Integrated Automation' },
  { key: 'electrical', name: 'Electrical' },
  { key: 'communications', name: 'Communications' },
  { key: 'electronic-safety-security', name: 'Electronic Safety & Security' },
];

// Built-in default mapping (library_id IS NULL). CSI-accurate division→discipline at
// single-division granularity: 21=Fire Suppression, 22=Plumbing, 23=HVAC, 25=Integrated
// Automation (I&C), 26=Electrical, 27=Communications, 28=Electronic Safety & Security.
const DEFAULT_RULES: readonly { key: string; start: string; end: string }[] = [
  { key: 'fire-suppression', start: '21', end: '21' },
  { key: 'plumbing', start: '22', end: '22' },
  { key: 'hvac', start: '23', end: '23' },
  { key: 'integrated-automation', start: '25', end: '25' },
  { key: 'electrical', start: '26', end: '26' },
  { key: 'communications', start: '27', end: '27' },
  { key: 'electronic-safety-security', start: '28', end: '28' },
];

function seedCatalog(pgm: MigrationBuilder): void {
  for (const { key, name } of DISCIPLINES) {
    pgm.sql(
      `INSERT INTO disciplines (key, name) VALUES ('${key}', '${name.replace(/'/g, "''")}')`
    );
  }
}

function seedDefaultRules(pgm: MigrationBuilder): void {
  for (const { key, start, end } of DEFAULT_RULES) {
    pgm.sql(
      `INSERT INTO discipline_section_rules (discipline_id, library_id, division_start, division_end)
       SELECT id, NULL, '${start}', '${end}' FROM disciplines WHERE key = '${key}'`
    );
  }
}

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('disciplines', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    key: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('disciplines', 'disciplines_key_nonempty', 'CHECK (length(trim(key)) > 0)');
  pgm.addConstraint('disciplines', 'disciplines_name_nonempty', 'CHECK (length(trim(name)) > 0)');

  pgm.createTable('discipline_section_rules', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    discipline_id: {
      type: 'uuid',
      notNull: true,
      references: 'disciplines',
      onDelete: 'CASCADE',
    },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' }, // NULL = built-in default
    division_start: { type: 'char(2)', notNull: true },
    division_end: { type: 'char(2)', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'discipline_section_rules',
    'discipline_section_rules_division_shape',
    "CHECK (division_start ~ '^[0-9]{2}$' AND division_end ~ '^[0-9]{2}$' AND division_start <= division_end)"
  );
  pgm.createIndex('discipline_section_rules', 'library_id', {
    name: 'discipline_section_rules_library_id_idx',
  });
  // No two rules (in the same scope) share a division range — keeps resolution deterministic.
  // Two partial unique indexes because NULL library_id is not comparable via a plain unique.
  pgm.sql(`CREATE UNIQUE INDEX discipline_section_rules_builtin_range
           ON discipline_section_rules (division_start, division_end)
           WHERE library_id IS NULL`);
  pgm.sql(`CREATE UNIQUE INDEX discipline_section_rules_library_range
           ON discipline_section_rules (library_id, division_start, division_end)
           WHERE library_id IS NOT NULL`);

  seedCatalog(pgm);
  seedDefaultRules(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('discipline_section_rules');
  pgm.dropTable('disciplines');
};
