import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { pool, DatabaseError } from '../index.js';
import type { DisciplineRuleInput } from '../../ast/index.js';

// ADR-065 — discipline mapping resolution. Rules map an inclusive CSI division range to a
// discipline, scoped per library. A library with any rules of its own uses ONLY those; a
// library with none inherits the built-in default (library_id IS NULL) — the same
// all-or-nothing scoped-profile inheritance as editing_conventions (ADR-022 D3).

/** Raised when a rule-set write references a discipline key that is not in the catalog. */
export class DisciplineNotFoundError extends DatabaseError {}

interface Queryable {
  query: Pool['query'];
}

/** One division-range rule surfaced under a discipline (read shape). */
export interface DisciplineRuleView {
  readonly divisionStart: string;
  readonly divisionEnd: string;
}

/** A catalog discipline with its rules resolved for a given scope. */
export interface ResolvedDiscipline {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly rules: readonly DisciplineRuleView[];
}

/** The full catalog resolved for a scope, plus whether it fell back to the built-in default. */
export interface ResolvedDisciplines {
  readonly disciplines: readonly ResolvedDiscipline[];
  readonly inherited: boolean;
}

/** A flat effective rule used to annotate spec rows with their discipline. */
export interface EffectiveRule {
  readonly disciplineKey: string;
  readonly divisionStart: string;
  readonly divisionEnd: string;
}

const RulesViewSchema = z.array(z.object({ divisionStart: z.string(), divisionEnd: z.string() }));

interface CatalogRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly rules: unknown;
  readonly inherited: boolean;
}

interface EffectiveRuleRow {
  readonly discipline_key: string;
  readonly division_start: string;
  readonly division_end: string;
}

// The library scope a read resolves against, computed inside the SAME statement as the rules
// it selects — so a concurrent clear/replace cannot commit between a scope lookup and the rules
// query and yield an inconsistent read (e.g. inherited=false with no override rows). A library
// with its own rules resolves to its id; otherwise (no libraryId, or none of its own) to NULL,
// the built-in default. Under READ COMMITTED successive statements can see different snapshots,
// so scope selection must live in the rules statement, not a separate one.
const SCOPE_CTE = `scope AS (
  SELECT EXISTS (SELECT 1 FROM discipline_section_rules WHERE library_id = $1::uuid) AS has_own
)`;
const SCOPE_LIBRARY_FILTER = `r.library_id IS NOT DISTINCT FROM
  (CASE WHEN (SELECT has_own FROM scope) THEN $1::uuid ELSE NULL END)`;

/**
 * The full discipline catalog with each discipline's division rules resolved for `libraryId`
 * (built-in default when omitted or when the library has no rules of its own). Unmapped
 * disciplines carry an empty `rules` array. `inherited` is derived from the same snapshot as
 * the rules. Backs GET /disciplines.
 */
export async function listDisciplines(
  libraryId?: string,
  db: Queryable = pool
): Promise<ResolvedDisciplines> {
  try {
    const res = await db.query<CatalogRow>(
      `WITH ${SCOPE_CTE}
       SELECT d.id, d.key, d.name,
              COALESCE(
                json_agg(
                  json_build_object('divisionStart', r.division_start, 'divisionEnd', r.division_end)
                  ORDER BY r.division_start
                ) FILTER (WHERE r.id IS NOT NULL),
                '[]'
              ) AS rules,
              NOT (SELECT has_own FROM scope) AS inherited
         FROM disciplines d
         LEFT JOIN discipline_section_rules r
           ON r.discipline_id = d.id
          AND ${SCOPE_LIBRARY_FILTER}
        GROUP BY d.id, d.key, d.name
        ORDER BY d.name`,
      [libraryId ?? null]
    );
    const disciplines = res.rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      rules: RulesViewSchema.parse(row.rules),
    }));
    // `inherited` is a per-library value repeated on every row; the catalog is always non-empty.
    const inherited = res.rows[0]?.inherited ?? true;
    return { disciplines, inherited };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('listDisciplines: query failed', { cause: err });
  }
}

/**
 * The flat effective rule set for a library (own rules else built-in default), ordered by
 * division. Small (one row per mapped division range) — callers annotate spec rows in memory
 * via `disciplineForSection`. Pass no libraryId to resolve the built-in default (used for
 * project listings, whose specs belong to no single library).
 */
export async function resolveEffectiveRules(
  libraryId: string | undefined,
  db: Queryable = pool
): Promise<readonly EffectiveRule[]> {
  try {
    const res = await db.query<EffectiveRuleRow>(
      `WITH ${SCOPE_CTE}
       SELECT d.key AS discipline_key, r.division_start, r.division_end
         FROM discipline_section_rules r
         JOIN disciplines d ON d.id = r.discipline_id
        WHERE ${SCOPE_LIBRARY_FILTER}
        ORDER BY r.division_start`,
      [libraryId ?? null]
    );
    return res.rows.map((row) => ({
      disciplineKey: row.discipline_key,
      divisionStart: row.division_start,
      divisionEnd: row.division_end,
    }));
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('resolveEffectiveRules: query failed', { cause: err });
  }
}

/**
 * Discipline key for a section under an effective rule set, or null when its division falls
 * outside every rule. Pure — the division is the section number's first two characters, and
 * division_start/division_end are 2-digit strings, so string comparison equals numeric order.
 */
export function disciplineForSection(
  section: string,
  rules: readonly EffectiveRule[]
): string | null {
  const division = section.slice(0, 2);
  if (!/^\d{2}$/.test(division)) return null;
  const match = rules.find((r) => r.divisionStart <= division && division <= r.divisionEnd);
  return match ? match.disciplineKey : null;
}

/**
 * Replace a library's discipline rule set wholesale (PUT semantics), atomically. Each rule's
 * `discipline` key must exist in the catalog — an unknown key rolls the whole write back with
 * DisciplineNotFoundError. Clearing to zero rules is a separate op (clearLibraryDisciplineRules).
 */
export async function replaceLibraryDisciplineRules(
  libraryId: string,
  rules: readonly DisciplineRuleInput[]
): Promise<void> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Serialize concurrent replacements for the same library: take the library row lock
    // before the wholesale delete+insert. Without it, two racing PUTs under READ COMMITTED
    // can each DELETE before seeing the other's not-yet-committed INSERTs, so their rule
    // sets union (violating wholesale replacement) or collide on the range unique index (500).
    await client.query('SELECT 1 FROM libraries WHERE id = $1 FOR UPDATE', [libraryId]);
    await client.query('DELETE FROM discipline_section_rules WHERE library_id = $1', [libraryId]);
    for (const rule of rules) {
      const res = await client.query(
        `INSERT INTO discipline_section_rules (discipline_id, library_id, division_start, division_end)
         SELECT id, $1, $2, $3 FROM disciplines WHERE key = $4`,
        [libraryId, rule.divisionStart, rule.divisionEnd, rule.discipline]
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new DisciplineNotFoundError(`unknown discipline: ${rule.discipline}`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client?.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`replaceLibraryDisciplineRules: failed for library ${libraryId}`, {
      cause: err,
    });
  } finally {
    client?.release();
  }
}

/**
 * Clear a library's own discipline rules, reverting it to the built-in default. Returns true
 * when at least one rule was removed, false when the library had no override. Serialized on the
 * library row (same lock as replaceLibraryDisciplineRules) so a clear racing a replacement can't
 * report `false` (no override) while the replacement's freshly-inserted rows remain.
 */
export async function clearLibraryDisciplineRules(libraryId: string): Promise<boolean> {
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM libraries WHERE id = $1 FOR UPDATE', [libraryId]);
    const res = await client.query('DELETE FROM discipline_section_rules WHERE library_id = $1', [
      libraryId,
    ]);
    await client.query('COMMIT');
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    try {
      await client?.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`clearLibraryDisciplineRules: failed for library ${libraryId}`, {
      cause: err,
    });
  } finally {
    client?.release();
  }
}
