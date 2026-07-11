import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { resolveEffectiveRules, disciplineForSection } from './disciplines.js';

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

// A spec owned by a library, with its paragraph count — the shape a library
// browser lists (GET /libraries/:id/specs). `withdrawnAt` is the ADR-030
// tombstone: null for an active master, an ISO-8601 timestamp for a withdrawn
// one (only surfaced when the listing opts into withdrawn masters).
// `discipline` is the spec's resolved discipline key under the library's mapping
// (built-in default unless the library overrides it), or null when its division
// is unmapped (ADR-065).
export interface LibrarySpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly withdrawnAt: string | null;
  readonly discipline: string | null;
}

/** Optional filters for a library's spec listing. */
export interface LibrarySpecListOptions {
  /** Surface withdrawn masters (ADR-030), each with a withdrawnAt timestamp. */
  readonly includeWithdrawn?: boolean;
  /** Keep only specs whose resolved discipline key equals this value (ADR-065). */
  readonly discipline?: string;
}

interface LibraryRow {
  readonly id: string;
  readonly tier: LibraryTier;
  readonly name: string;
  readonly owner: string | null;
  readonly parent_library_id: string | null;
  readonly created_at: Date;
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

// Raised when a library id has no matching row — mapped to 404 (REST) / tool
// error (MCP) by callers that need a whole-library scope (e.g. reference-graph).
export class LibraryNotFoundError extends DatabaseError {}

// Parent-resolution failures for createClientLibrary. Callers map each to their
// own surface — REST to an HTTP status, MCP to a tool error.
export class ParentLibraryNotFoundError extends DatabaseError {}
export class ParentLibraryNotCompanyError extends DatabaseError {}
export class DefaultCompanyLibraryError extends DatabaseError {}

export interface CreateClientLibraryInput {
  readonly name: string;
  readonly parentLibraryId?: string;
}

// Resolve the company-tier parent for a new client library: an explicit parent
// (which must be company-tier) or the seeded Default Company Master. Throws a
// typed error the caller maps to its own surface.
async function resolveClientParent(
  parentLibraryId: string | undefined,
  db: Queryable
): Promise<Library> {
  if (parentLibraryId) {
    const parent = await findLibraryById(parentLibraryId, db);
    if (!parent) throw new ParentLibraryNotFoundError('parent library not found');
    if (parent.tier !== 'company') {
      throw new ParentLibraryNotCompanyError('parent library must be company-tier');
    }
    return parent;
  }
  const company = await findLibraryByName(DEFAULT_COMPANY_LIBRARY, db);
  if (!company) throw new DefaultCompanyLibraryError('default company library missing');
  if (company.tier !== 'company') {
    throw new DefaultCompanyLibraryError('default company library misconfigured');
  }
  return company;
}

// Create a client library under its resolved company-tier parent, owner = name.
// Single source of truth for the REST handler and the MCP tool.
export async function createClientLibrary(
  input: CreateClientLibraryInput,
  db: Queryable = pool
): Promise<Library> {
  const parent = await resolveClientParent(input.parentLibraryId, db);
  const createInput: CreateLibraryInput = {
    tier: 'client',
    name: input.name,
    owner: input.name,
    parentLibraryId: parent.id,
  };
  return createLibrary(createInput, db);
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

interface LibrarySpecRow {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly node_count: number;
  readonly withdrawn_at: Date | null;
}

/**
 * Lists the specs owned by a library with each spec's paragraph node count,
 * ordered by section. The library's existence is the caller's concern (404).
 *
 * Withdrawn masters (ADR-030) are hidden by default — they remain GET-able by
 * id and restorable via `POST /specs/:id/restore`. Pass `includeWithdrawn` to
 * surface them (with a non-null `withdrawnAt`) so a browse-and-restore flow can
 * discover the spec UUID `restore` needs (#416).
 *
 * Each row carries its resolved `discipline` under the library's mapping (ADR-065).
 * Pass `discipline` to keep only specs that resolve to that discipline key.
 */
export async function listLibrarySpecs(
  libraryId: string,
  options: LibrarySpecListOptions = {},
  db: Queryable = pool
): Promise<readonly LibrarySpec[]> {
  const { includeWithdrawn = false, discipline } = options;
  try {
    const result = await db.query<LibrarySpecRow>(
      `SELECT s.id, s.section, s.title, s.withdrawn_at, COUNT(p.id)::int AS node_count
         FROM specs s
         LEFT JOIN paragraphs p ON p.spec_id = s.id
        WHERE s.library_id = $1 AND ($2 OR s.withdrawn_at IS NULL)
        GROUP BY s.id, s.section, s.title, s.withdrawn_at
        ORDER BY s.section`,
      [libraryId, includeWithdrawn]
    );
    const rules = await resolveEffectiveRules(libraryId, db);
    const specs = result.rows.map((row) => ({
      specId: row.id,
      section: row.section,
      title: row.title,
      nodeCount: row.node_count,
      withdrawnAt: row.withdrawn_at ? row.withdrawn_at.toISOString() : null,
      discipline: disciplineForSection(row.section, rules),
    }));
    return discipline === undefined ? specs : specs.filter((s) => s.discipline === discipline);
  } catch (err) {
    throw new DatabaseError(`listLibrarySpecs: query failed for library ${libraryId}`, {
      cause: err,
    });
  }
}

/**
 * Renames a library (name only; owner/tier/parent unchanged). Returns the
 * updated row, or null if no library has that id. A duplicate name surfaces as
 * a PG 23505 the caller maps to 409.
 */
export async function updateLibraryName(
  id: string,
  name: string,
  db: Queryable = pool
): Promise<Library | null> {
  try {
    const result = await db.query<LibraryRow>(
      `UPDATE libraries SET name = $2 WHERE id = $1 RETURNING ${LIBRARY_COLUMNS}`,
      [id, name]
    );
    const row = result.rows[0];
    return row ? mapLibraryRow(row) : null;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`updateLibraryName: update failed for ${id}`, { cause: err });
  }
}
