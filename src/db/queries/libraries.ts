import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';

export type LibraryTier = 'reference' | 'company' | 'client';

// Built-in libraries seeded by migration 016. Names are the lookup key; the
// migration duplicates these literals (frozen snapshot — no src/ imports there).
export const UFGS_REFERENCE_LIBRARY = 'UFGS Reference';
export const DEFAULT_COMPANY_LIBRARY = 'Default Company Master';

export interface Library {
  readonly id: string;
  readonly tier: LibraryTier;
  readonly name: string;
  readonly owner: string | null;
  readonly parentLibraryId: string | null;
  readonly createdAt: Date;
}

export interface CreateLibraryInput {
  readonly tier: LibraryTier;
  readonly name: string;
  readonly owner?: string;
  readonly parentLibraryId?: string;
}

export interface LibrarySpecEntry {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
}

interface LibraryRow {
  readonly id: string;
  readonly tier: LibraryTier;
  readonly name: string;
  readonly owner: string | null;
  readonly parent_library_id: string | null;
  readonly created_at: Date;
}

interface LibrarySpecRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
  readonly node_count: string;
}

interface Queryable {
  query: Pool['query'];
}

const LIBRARY_COLUMNS = 'id, tier, name, owner, parent_library_id, created_at';

function mapLibraryRow(row: LibraryRow): Library {
  return {
    id: row.id,
    tier: row.tier,
    name: row.name,
    owner: row.owner,
    parentLibraryId: row.parent_library_id,
    createdAt: row.created_at,
  };
}

export async function createLibrary(
  input: CreateLibraryInput,
  db: Queryable = pool
): Promise<Library> {
  try {
    const result = await db.query<LibraryRow>(
      `INSERT INTO libraries (tier, name, owner, parent_library_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${LIBRARY_COLUMNS}`,
      [input.tier, input.name, input.owner ?? null, input.parentLibraryId ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createLibrary: no row returned after insert');
    return mapLibraryRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`createLibrary: insert failed for "${input.name}"`, { cause: err });
  }
}

export async function findLibraryById(id: string, db: Queryable = pool): Promise<Library | null> {
  try {
    const result = await db.query<LibraryRow>(
      `SELECT ${LIBRARY_COLUMNS} FROM libraries WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapLibraryRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`findLibraryById: query failed for ${id}`, { cause: err });
  }
}

export async function findLibraryByName(
  name: string,
  db: Queryable = pool
): Promise<Library | null> {
  try {
    const result = await db.query<LibraryRow>(
      `SELECT ${LIBRARY_COLUMNS} FROM libraries WHERE name = $1`,
      [name]
    );
    const row = result.rows[0];
    return row ? mapLibraryRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`findLibraryByName: query failed for "${name}"`, { cause: err });
  }
}

export async function listLibraries(db: Queryable = pool): Promise<readonly Library[]> {
  try {
    const result = await db.query<LibraryRow>(
      `SELECT ${LIBRARY_COLUMNS} FROM libraries ORDER BY tier, name`
    );
    return result.rows.map(mapLibraryRow);
  } catch (err) {
    throw new DatabaseError('listLibraries: query failed', { cause: err });
  }
}

export async function updateLibraryName(
  id: string,
  name: string,
  db: Queryable = pool
): Promise<Library | null> {
  try {
    const result = await db.query<LibraryRow>(
      `UPDATE libraries SET name = $1, owner = CASE WHEN tier = 'client' THEN $1 ELSE owner END
       WHERE id = $2
       RETURNING ${LIBRARY_COLUMNS}`,
      [name, id]
    );
    const row = result.rows[0];
    return row ? mapLibraryRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`updateLibraryName: query failed for ${id}`, { cause: err });
  }
}

export async function listLibrarySpecs(
  libraryId: string,
  db: Queryable = pool
): Promise<readonly LibrarySpecEntry[] | null> {
  try {
    const lib = await db.query('SELECT 1 FROM libraries WHERE id = $1', [libraryId]);
    if (lib.rowCount === 0) return null;
    const result = await db.query<LibrarySpecRow>(
      `SELECT s.id, s.section, s.title, COUNT(p.id) AS node_count
       FROM specs s
       LEFT JOIN paragraphs p ON p.spec_id = s.id
       WHERE s.library_id = $1
       GROUP BY s.id, s.section, s.title
       ORDER BY s.section, s.title`,
      [libraryId]
    );
    return result.rows.map((row) => ({
      specId: row.id,
      section: row.section ?? '',
      title: row.title ?? '',
      nodeCount: Number(row.node_count),
    }));
  } catch (err) {
    throw new DatabaseError(`listLibrarySpecs: query failed for ${libraryId}`, { cause: err });
  }
}

/**
 * Default ownership for ingested masters (ADR-015): UFGS corpus loads land in
 * the read-only reference library; everything else is firm content and lands
 * in the default company master. Keeps corpus re-ingest idempotent.
 */
export async function resolveDefaultLibraryId(
  source: string,
  db: Queryable = pool
): Promise<string> {
  const name = source === 'ufgs' ? UFGS_REFERENCE_LIBRARY : DEFAULT_COMPANY_LIBRARY;
  try {
    const result = await db.query<{ id: string }>(`SELECT id FROM libraries WHERE name = $1`, [
      name,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new DatabaseError(
        `resolveDefaultLibraryId: built-in library "${name}" missing — run migrations`
      );
    }
    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`resolveDefaultLibraryId: lookup failed for source "${source}"`, {
      cause: err,
    });
  }
}
