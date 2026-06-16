import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ADR-022 D3 — convention profiles are library-scoped data with built-in defaults.
 *
 * `editing_conventions` holds a JSONB ruleset per ADR-015 library. Rows with
 * `library_id IS NULL` are built-in industry defaults that power first-pass
 * classification when a library has no profile yet (validated by
 * ConventionRulesSchema; the JSONB column stays open to preserve unknown keys).
 *
 * The seeded 'Industry Default' `noteBanners` are lifted VERBATIM from
 * src/parser/docx/heuristics.ts (NOTE_TO_SPECIFIER_PATTERN, SPECIFIER_NOTES_PATTERN):
 * banner detection moves from hardcoded to data-driven with no behavior change.
 * Migrations are frozen snapshots — the literal below is duplicated here and is
 * never imported from src/ runtime code.
 */

const INDUSTRY_DEFAULT_RULES = {
  colorMeanings: [{ color: '0000FF', meaning: 'editable' }],
  choiceTokens: [{ kind: 'angle' }, { kind: 'bracket' }],
  noteBanners: ['^NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\\b', '^SPEC(?:IFIER)?S? NOTES?\\b'],
  comments: { treatAs: 'note' },
  defaultEditability: 'locked',
};

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('editing_conventions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    library_id: { type: 'uuid', references: 'libraries' }, // NULL = built-in default
    name: { type: 'text', notNull: true },
    rules: { type: 'jsonb', notNull: true, default: '{}' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Keep the built-in default a singleton so the fallback lookup is deterministic.
  pgm.createIndex('editing_conventions', ['name'], {
    name: 'editing_conventions_builtin_unique',
    unique: true,
    where: 'library_id IS NULL',
  });

  // Escape single quotes defensively — values are static and quote-free today.
  const rulesLiteral = JSON.stringify(INDUSTRY_DEFAULT_RULES).replace(/'/g, "''");
  pgm.sql(
    `INSERT INTO editing_conventions (library_id, name, rules)
     VALUES (NULL, 'Industry Default', '${rulesLiteral}'::jsonb)`
  );
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('editing_conventions');
};
