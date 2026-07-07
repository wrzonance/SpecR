import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { getPgCode } from '../../lib/pg-errors.js';
import type { ProjectSummary, ProjectSource } from './projects.js';

interface Queryable {
  query: Pool['query'];
}

export interface ClientSummary {
  readonly id: string;
  readonly name: string;
  readonly libraryId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ClientDetail extends ClientSummary {
  /** The client's associated projects (active only), each a full ProjectSummary. */
  readonly projects: readonly ProjectSummary[];
}

export interface CreateClientInput {
  readonly name: string;
  /** Optional link to the client's client-tier master library (ADR-054). */
  readonly libraryId?: string;
}

/** A project's update path referenced an unknown client → 422 at the handler. */
export class ClientNotFoundError extends DatabaseError {}

/** createClient was given a libraryId that does not exist → 422 at the handler. */
export class ClientLibraryNotFoundError extends DatabaseError {}

interface ClientRow {
  readonly id: string;
  readonly name: string;
  readonly library_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface ClientProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly client_id: string;
  readonly client_name: string;
  // json_agg over the project's ordered sources; COALESCE'd to [] in SQL, but the
  // driver can still surface NULL defensively — mapped with `?? []`.
  readonly sources: readonly ProjectSource[] | null;
}

const CLIENT_COLUMNS = 'id, name, library_id, created_at, updated_at';

function mapClientRow(row: ClientRow): ClientSummary {
  return {
    id: row.id,
    name: row.name,
    libraryId: row.library_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapClientProject(row: ClientProjectRow): ProjectSummary {
  return {
    projectId: row.id,
    name: row.name,
    description: row.description,
    clientId: row.client_id,
    clientName: row.client_name,
    sources: row.sources ?? [],
  };
}

/** Throw ClientLibraryNotFoundError when a supplied libraryId has no row. */
async function assertLibraryExists(libraryId: string, db: Queryable): Promise<void> {
  const result = await db.query<{ one: number }>('SELECT 1 AS one FROM libraries WHERE id = $1', [
    libraryId,
  ]);
  if (result.rows.length === 0) {
    throw new ClientLibraryNotFoundError(`library ${libraryId} not found`);
  }
}

/** Throw ClientNotFoundError when a client id has no row. Used by the project
 *  update path to validate an association before writing it (→ 422, not a raw FK). */
export async function assertClientExists(clientId: string, db: Queryable = pool): Promise<void> {
  const result = await db.query<{ one: number }>('SELECT 1 AS one FROM clients WHERE id = $1', [
    clientId,
  ]);
  if (result.rows.length === 0) {
    throw new ClientNotFoundError(`client ${clientId} not found`);
  }
}

export async function createClient(
  input: CreateClientInput,
  db: Queryable = pool
): Promise<ClientSummary> {
  try {
    if (input.libraryId) await assertLibraryExists(input.libraryId, db);
    const result = await db.query<ClientRow>(
      `INSERT INTO clients (name, library_id) VALUES ($1, $2) RETURNING ${CLIENT_COLUMNS}`,
      [input.name, input.libraryId ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createClient: no row returned after insert');
    return mapClientRow(row);
  } catch (err) {
    // ClientLibraryNotFoundError / DatabaseError re-throw unwrapped; a raw pg error
    // (e.g. 23505 unique name) is wrapped with its cause so getPgCode → 409 at the handler.
    if (err instanceof DatabaseError) throw err;
    const wrapped = new DatabaseError(`createClient: insert failed for "${input.name}"`, {
      cause: err,
    });
    // TOCTOU: assertLibraryExists passed, but the library can be deleted before this
    // INSERT; the FK then raises 23503 — map it to the same clean 422
    // (ClientLibraryNotFoundError) as the fast-path check. A 23505 (duplicate name)
    // keeps the generic wrap → 409 at the handler.
    if (input.libraryId && getPgCode(wrapped) === '23503') {
      throw new ClientLibraryNotFoundError(`library ${input.libraryId} not found`, { cause: err });
    }
    throw wrapped;
  }
}

export async function listClients(db: Queryable = pool): Promise<readonly ClientSummary[]> {
  try {
    const result = await db.query<ClientRow>(
      `SELECT ${CLIENT_COLUMNS} FROM clients ORDER BY name, id`
    );
    return result.rows.map(mapClientRow);
  } catch (err) {
    throw new DatabaseError('listClients: query failed', { cause: err });
  }
}

// A client's active projects as full ProjectSummary rows: each project's ordered
// source libraries are aggregated in one LATERAL json_agg (no N+1), and clientName
// rides the inner JOIN. Soft-deleted projects (deleted_at) are hidden, matching
// listProjects — a withdrawn project drops off the client view.
const CLIENT_PROJECTS_SQL = `
  SELECT p.id, p.name, p.description, p.client_id, c.name AS client_name,
         COALESCE(s.sources, '[]'::json) AS sources
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    LEFT JOIN LATERAL (
      SELECT json_agg(
               json_build_object(
                 'libraryId', ps.library_id, 'name', l.name,
                 'tier', l.tier, 'priority', ps.priority
               ) ORDER BY ps.priority
             ) AS sources
        FROM project_sources ps
        JOIN libraries l ON l.id = ps.library_id
       WHERE ps.project_id = p.id
    ) s ON true
   WHERE p.client_id = $1 AND p.deleted_at IS NULL
   ORDER BY p.name, p.id`;

async function fetchClientProjects(
  clientId: string,
  db: Queryable
): Promise<readonly ProjectSummary[]> {
  const result = await db.query<ClientProjectRow>(CLIENT_PROJECTS_SQL, [clientId]);
  return result.rows.map(mapClientProject);
}

export async function getClient(id: string, db: Queryable = pool): Promise<ClientDetail | null> {
  let client: ClientRow | undefined;
  try {
    const result = await db.query<ClientRow>(
      `SELECT ${CLIENT_COLUMNS} FROM clients WHERE id = $1`,
      [id]
    );
    client = result.rows[0];
  } catch (err) {
    throw new DatabaseError(`getClient: query failed for ${id}`, { cause: err });
  }
  if (!client) return null;
  try {
    const projects = await fetchClientProjects(id, db);
    return { ...mapClientRow(client), projects };
  } catch (err) {
    throw new DatabaseError(`getClient: projects query failed for ${id}`, { cause: err });
  }
}
