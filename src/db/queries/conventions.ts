import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { ConventionRulesSchema } from '../../ast/index.js';
import type { ConventionRules } from '../../ast/index.js';
import { checkRegexPatterns } from '../../lib/regex-safety.js';

// Seeded by migration 024; the singleton built-in (library_id IS NULL) that
// powers first-pass classification before a library has its own profile.
export const BUILT_IN_CONVENTION_NAME = 'Industry Default';

/** Raised when a convention write carries an oversized or unsafe regex (ADR-022 D5). */
export class ConventionValidationError extends DatabaseError {}

/** Raised when an update targets a convention id that does not exist. */
export class ConventionNotFoundError extends DatabaseError {}

export interface EditingConvention {
  readonly id: string;
  readonly libraryId: string | null;
  readonly name: string;
  readonly rules: ConventionRules;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateConventionInput {
  readonly libraryId?: string;
  readonly name: string;
  readonly rules?: ConventionRules;
}

interface ConventionRow {
  readonly id: string;
  readonly library_id: string | null;
  readonly name: string;
  readonly rules: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface Queryable {
  query: Pool['query'];
}

const COLUMNS = 'id, library_id, name, rules, created_at, updated_at';

function mapRow(row: ConventionRow): EditingConvention {
  return {
    id: row.id,
    libraryId: row.library_id,
    name: row.name,
    rules: ConventionRulesSchema.parse(row.rules),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Write boundary: shape-validate (open schema) then bound the user-supplied
// noteBanners regexes. Captured facts are never rejected; conventions are.
function validateRules(rules: ConventionRules): ConventionRules {
  const parsed = ConventionRulesSchema.parse(rules);
  const safety = checkRegexPatterns(parsed.noteBanners ?? []);
  if (!safety.safe) {
    throw new ConventionValidationError(`unsafe noteBanners regex: ${safety.reason}`);
  }
  return parsed;
}

export async function insertConvention(
  input: CreateConventionInput,
  db: Queryable = pool
): Promise<EditingConvention> {
  const rules = validateRules(input.rules ?? {});
  try {
    const result = await db.query<ConventionRow>(
      `INSERT INTO editing_conventions (library_id, name, rules)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [input.libraryId ?? null, input.name, JSON.stringify(rules)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('insertConvention: no row returned after insert');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`insertConvention: insert failed for "${input.name}"`, { cause: err });
  }
}

export async function updateConventionRules(
  id: string,
  rules: ConventionRules,
  db: Queryable = pool
): Promise<EditingConvention> {
  const validated = validateRules(rules);
  try {
    const result = await db.query<ConventionRow>(
      `UPDATE editing_conventions SET rules = $2, updated_at = now()
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, JSON.stringify(validated)]
    );
    const row = result.rows[0];
    if (!row) throw new ConventionNotFoundError(`updateConventionRules: no convention ${id}`);
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`updateConventionRules: update failed for ${id}`, { cause: err });
  }
}

export async function findConventionById(
  id: string,
  db: Queryable = pool
): Promise<EditingConvention | null> {
  try {
    const result = await db.query<ConventionRow>(
      `SELECT ${COLUMNS} FROM editing_conventions WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`findConventionById: query failed for ${id}`, { cause: err });
  }
}

export async function getBuiltInConvention(
  db: Queryable = pool
): Promise<EditingConvention | null> {
  try {
    const result = await db.query<ConventionRow>(
      `SELECT ${COLUMNS} FROM editing_conventions
       WHERE library_id IS NULL
       ORDER BY created_at
       LIMIT 1`
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new DatabaseError('getBuiltInConvention: query failed', { cause: err });
  }
}

/**
 * All built-in convention profiles (library_id IS NULL). The singleton index
 * admits at most one today, but the list shape keeps the read API stable if the
 * built-in set ever grows. Read-only: built-ins are never written via the API.
 */
export async function listBuiltInConventions(
  db: Queryable = pool
): Promise<readonly EditingConvention[]> {
  try {
    const result = await db.query<ConventionRow>(
      `SELECT ${COLUMNS} FROM editing_conventions
       WHERE library_id IS NULL
       ORDER BY created_at`
    );
    return result.rows.map(mapRow);
  } catch (err) {
    throw new DatabaseError('listBuiltInConventions: query failed', { cause: err });
  }
}

/**
 * Create or replace a library's own convention profile (PUT semantics). One row
 * per library, enforced by the partial unique index on library_id (migration
 * 025); the write is a single atomic upsert so concurrent PUTs converge instead
 * of racing. Rules are shape-validated and noteBanners regexes are bounded
 * before storage.
 */
export async function upsertLibraryConvention(
  libraryId: string,
  name: string,
  rules: ConventionRules,
  db: Queryable = pool
): Promise<EditingConvention> {
  const validated = validateRules(rules);
  try {
    // Atomic upsert: the partial unique index on library_id (migration 025) is
    // the conflict target, so two concurrent PUTs for the same library both
    // resolve to the one row rather than racing into a unique-violation 500.
    const result = await db.query<ConventionRow>(
      `INSERT INTO editing_conventions (library_id, name, rules)
       VALUES ($1, $2, $3)
       ON CONFLICT (library_id) WHERE library_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, rules = EXCLUDED.rules, updated_at = now()
       RETURNING ${COLUMNS}`,
      [libraryId, name, JSON.stringify(validated)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('upsertLibraryConvention: no row returned');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`upsertLibraryConvention: failed for library ${libraryId}`, {
      cause: err,
    });
  }
}

/**
 * Seed a library's own convention profile ONLY when it has none — insert-only
 * (ON CONFLICT DO NOTHING), the read-modify-write-safe sibling of
 * upsertLibraryConvention (#139). Used by onboarding finalize to snapshot the
 * resolved rules into the library: if a profile already exists (or a concurrent
 * PUT created one), the user's edit is left intact rather than overwritten with
 * built-in defaults. Returns true when a row was inserted, false when one was
 * already present. Pass the transaction client so the seed is atomic with the
 * finalize flip.
 */
export async function seedLibraryConventionIfAbsent(
  libraryId: string,
  name: string,
  rules: ConventionRules,
  db: Queryable = pool
): Promise<boolean> {
  const validated = validateRules(rules);
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO editing_conventions (library_id, name, rules)
       VALUES ($1, $2, $3)
       ON CONFLICT (library_id) WHERE library_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [libraryId, name, JSON.stringify(validated)]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`seedLibraryConventionIfAbsent: failed for library ${libraryId}`, {
      cause: err,
    });
  }
}

/**
 * Load the convention profile for a library, falling back to the built-in
 * industry default when the library has no profile of its own (ADR-022 D3).
 */
export async function getConventionForLibrary(
  libraryId: string,
  db: Queryable = pool
): Promise<EditingConvention | null> {
  try {
    const result = await db.query<ConventionRow>(
      `SELECT ${COLUMNS} FROM editing_conventions
       WHERE library_id = $1
       ORDER BY created_at
       LIMIT 1`,
      [libraryId]
    );
    const row = result.rows[0];
    if (row) return mapRow(row);
    return getBuiltInConvention(db);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getConventionForLibrary: query failed for ${libraryId}`, {
      cause: err,
    });
  }
}
