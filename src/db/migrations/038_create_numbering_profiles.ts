import type { MigrationBuilder } from 'node-pg-migrate';

// ADR-015 scoped-profile pattern (mirrors editing_conventions #137). The built-in
// 'CSI Default' (library_id IS NULL) encodes the integer-PART, max-5 tier model so
// an unassigned spec resolves to today's engine behavior. Frozen snapshot — never
// imported from src/ runtime.
const CSI_DEFAULT_RULES = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('numbering_profiles', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', references: 'libraries', onDelete: 'CASCADE' }, // NULL = built-in default
    name: { type: 'text', notNull: true },
    rules: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint(
    'numbering_profiles',
    'numbering_profiles_name_nonempty',
    'CHECK (length(trim(name)) > 0)'
  );
  pgm.sql(`CREATE UNIQUE INDEX numbering_profiles_builtin_singleton
           ON numbering_profiles ((library_id IS NULL)) WHERE library_id IS NULL`);
  const literal = JSON.stringify(CSI_DEFAULT_RULES).replace(/'/g, "''");
  pgm.sql(`INSERT INTO numbering_profiles (library_id, name, rules)
           VALUES (NULL, 'CSI Default', '${literal}'::jsonb)`);

  pgm.addColumns('specs', {
    numbering_profile_id: { type: 'uuid', references: 'numbering_profiles', onDelete: 'RESTRICT' },
  });
  pgm.createIndex('specs', 'numbering_profile_id', { name: 'specs_numbering_profile_id_idx' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropIndex('specs', 'numbering_profile_id', { name: 'specs_numbering_profile_id_idx' });
  pgm.dropColumns('specs', ['numbering_profile_id']);
  pgm.dropTable('numbering_profiles');
};
