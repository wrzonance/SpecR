import type { MigrationBuilder } from 'node-pg-migrate';

// Language rule profiles hold a firm's banned-term / reinforcing-word /
// party-vocabulary / required-phrase lists. Scope mirrors ADR-015's
// division_general_specs (migration 022): exactly one of library_id /
// project_id is set per row (never both, never neither) — same 2-column
// XOR shape, not a 3-column "scope type" discriminator. See ADR-080.

export const up = (pgm: MigrationBuilder): void => {
  createLanguageRuleProfilesTable(pgm);
  addLanguageRuleProfilesConstraints(pgm);
  addLanguageRuleProfilesIndexes(pgm);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('language_rule_profiles');
};

const createLanguageRuleProfilesTable = (pgm: MigrationBuilder): void => {
  pgm.createTable('language_rule_profiles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' },
    project_id: { type: 'uuid', references: 'projects', onDelete: 'CASCADE' },
    rules: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

const addLanguageRuleProfilesConstraints = (pgm: MigrationBuilder): void => {
  pgm.addConstraint('language_rule_profiles', 'language_rule_profiles_owner_xor', {
    check: '(library_id IS NULL) <> (project_id IS NULL)',
  });
  pgm.addConstraint('language_rule_profiles', 'language_rule_profiles_rules_shape_check', {
    check: "jsonb_typeof(rules) = 'object'",
  });
};

const addLanguageRuleProfilesIndexes = (pgm: MigrationBuilder): void => {
  pgm.createIndex('language_rule_profiles', 'library_id', {
    name: 'language_rule_profiles_library_unique',
    unique: true,
    where: 'library_id IS NOT NULL',
  });
  pgm.createIndex('language_rule_profiles', 'project_id', {
    name: 'language_rule_profiles_project_unique',
    unique: true,
    where: 'project_id IS NOT NULL',
  });
};
