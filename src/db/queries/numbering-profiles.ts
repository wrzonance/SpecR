import { pool, DatabaseError } from '../index.js';
import { NumberingProfileSchema } from '../../ast/index.js';
import type { NumberingProfile } from '../../ast/index.js';
import { getPgCode } from '../../lib/pg-errors.js';

/** Raised when a DELETE targets a profile that is still referenced by one or more specs (pg 23503). */
export class NumberingProfileInUseError extends DatabaseError {}

export interface NumberingProfileRow {
  readonly id: string;
  readonly libraryId: string | null;
  readonly name: string;
  readonly rules: NumberingProfile;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface RawRow {
  readonly id: string;
  readonly library_id: string | null;
  readonly name: string;
  readonly rules: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = 'id, library_id, name, rules, created_at, updated_at';

function rowToProfile(row: RawRow): NumberingProfileRow {
  return {
    id: row.id,
    libraryId: row.library_id,
    name: row.name,
    rules: NumberingProfileSchema.parse(row.rules),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parse raw JSONB rules; wraps ZodError as DatabaseError so callers get typed failures. */
function parseRules(specId: string, raw: unknown): NumberingProfile {
  try {
    return NumberingProfileSchema.parse(raw);
  } catch (zodErr) {
    throw new DatabaseError(`getEffectiveNumberingProfile: invalid rules for spec ${specId}`, {
      cause: zodErr,
    });
  }
}

/** Fetch the singleton built-in CSI Default's raw rules from the DB. */
async function resolveBuiltInRules(): Promise<unknown> {
  const res = await pool.query<{ rules: unknown }>(
    `SELECT rules FROM numbering_profiles WHERE library_id IS NULL ORDER BY created_at LIMIT 1`
  );
  const row = res.rows[0];
  if (!row) throw new DatabaseError('resolveBuiltInRules: CSI Default not found in DB');
  return row.rules;
}

/**
 * Library's own profiles PLUS the built-in CSI Default (library_id IS NULL).
 * Ordered: library rows first (by created_at), built-in last.
 */
export async function listNumberingProfiles(libraryId: string): Promise<NumberingProfileRow[]> {
  try {
    const result = await pool.query<RawRow>(
      `SELECT ${COLUMNS} FROM numbering_profiles
       WHERE library_id = $1 OR library_id IS NULL
       ORDER BY library_id NULLS LAST, created_at`,
      [libraryId]
    );
    return result.rows.map(rowToProfile);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`listNumberingProfiles: query failed for library ${libraryId}`, {
      cause: err,
    });
  }
}

export async function getNumberingProfile(id: string): Promise<NumberingProfileRow | null> {
  try {
    const result = await pool.query<RawRow>(
      `SELECT ${COLUMNS} FROM numbering_profiles WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? rowToProfile(row) : null;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getNumberingProfile: query failed for ${id}`, { cause: err });
  }
}

export async function createNumberingProfile(
  libraryId: string,
  name: string,
  rules: NumberingProfile
): Promise<NumberingProfileRow> {
  const parsed = NumberingProfileSchema.parse(rules);
  try {
    const result = await pool.query<RawRow>(
      `INSERT INTO numbering_profiles (library_id, name, rules)
       VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [libraryId, name, JSON.stringify(parsed)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createNumberingProfile: no row returned after insert');
    return rowToProfile(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createNumberingProfile: insert failed for "${name}"`, { cause: err });
  }
}

/**
 * Partial update: omit a field to leave it unchanged.
 * Returns null when the id is not found.
 */
export async function updateNumberingProfile(
  id: string,
  patch: { name?: string; rules?: NumberingProfile }
): Promise<NumberingProfileRow | null> {
  const parsedRules =
    patch.rules !== undefined ? JSON.stringify(NumberingProfileSchema.parse(patch.rules)) : null;
  try {
    // `AND library_id IS NOT NULL` makes the built-in CSI Default immutable at the
    // data layer (defense-in-depth beneath the handler's 409): the built-in backs
    // getEffectiveNumberingProfile for every unassigned spec, so a mutated default
    // would silently corrupt that global fallback. Mirrors the delete guard.
    const result = await pool.query<RawRow>(
      `UPDATE numbering_profiles
       SET name        = COALESCE($2, name),
           rules       = COALESCE($3::jsonb, rules),
           updated_at  = now()
       WHERE id = $1 AND library_id IS NOT NULL
       RETURNING ${COLUMNS}`,
      [id, patch.name ?? null, parsedRules]
    );
    const row = result.rows[0];
    return row ? rowToProfile(row) : null;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`updateNumberingProfile: update failed for ${id}`, { cause: err });
  }
}

/**
 * Delete a library-owned profile. Returns false when not found.
 * The built-in CSI Default (`library_id IS NULL`) is never deletable — this query
 * silently excludes it, so callers get `false` (→ 404) rather than accidentally
 * removing the shared fallback row.
 * Throws NumberingProfileInUseError when a spec still references this profile (pg 23503 RESTRICT).
 */
export async function deleteNumberingProfile(id: string): Promise<boolean> {
  try {
    const result = await pool.query(
      `DELETE FROM numbering_profiles WHERE id = $1 AND library_id IS NOT NULL`,
      [id]
    );
    return (result.rowCount ?? 0) === 1;
  } catch (err) {
    const dbErr =
      err instanceof DatabaseError
        ? err
        : new DatabaseError(`deleteNumberingProfile: delete failed for ${id}`, { cause: err });
    if (getPgCode(dbErr) === '23503') {
      throw new NumberingProfileInUseError(
        `numbering profile ${id} is referenced by one or more specs`,
        { cause: err }
      );
    }
    throw dbErr;
  }
}

/** Assign (or replace) a spec's numbering profile. Returns false when the spec does not exist. */
export async function setSpecNumberingProfile(specId: string, profileId: string): Promise<boolean> {
  try {
    const result = await pool.query(`UPDATE specs SET numbering_profile_id = $2 WHERE id = $1`, [
      specId,
      profileId,
    ]);
    return (result.rowCount ?? 0) === 1;
  } catch (err) {
    throw new DatabaseError('setSpecNumberingProfile: update failed', { cause: err });
  }
}

/** Clear a spec's numbering profile (idempotent). Returns false when the spec does not exist. */
export async function clearSpecNumberingProfile(specId: string): Promise<boolean> {
  try {
    const result = await pool.query(`UPDATE specs SET numbering_profile_id = NULL WHERE id = $1`, [
      specId,
    ]);
    return (result.rowCount ?? 0) === 1;
  } catch (err) {
    throw new DatabaseError('clearSpecNumberingProfile: update failed', { cause: err });
  }
}

/**
 * Resolve the effective numbering profile for a spec.
 * Returns the assigned profile's rules if set; else the built-in CSI Default.
 * Always returns a valid NumberingProfile — never null.
 * Wraps ZodError as DatabaseError with the original error as cause.
 */
export async function getEffectiveNumberingProfile(specId: string): Promise<NumberingProfile> {
  try {
    const result = await pool.query<{ rules: unknown }>(
      `SELECT np.rules
       FROM specs s
       LEFT JOIN numbering_profiles np ON np.id = s.numbering_profile_id
       WHERE s.id = $1`,
      [specId]
    );
    const rawRules = result.rows[0]?.rules ?? null;
    const rules = rawRules ?? (await resolveBuiltInRules());
    return parseRules(specId, rules);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getEffectiveNumberingProfile: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}
