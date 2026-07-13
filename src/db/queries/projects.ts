import { DatabaseError } from '../errors.js';
import type { Pool, PoolClient } from 'pg';
import { assertClientExists, ClientNotFoundError } from './clients.js';
import { getPgCode } from '../../lib/pg-errors.js';
import type { LibraryTier } from './libraries.js';
import { parseSectionNumberFormat } from '../../lib/section-number.js';
import type { SectionNumberFormat } from '../../lib/section-number.js';

interface Queryable {
  query: Pool['query'];
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly deleted_at: Date | null;
  readonly deleted_by: string | null;
  readonly section_number_format: string;
}

interface ProjectListRow {
  readonly id: string;
  readonly name: string;
}

interface TocRow {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

interface SourceLibRow {
  readonly id: string;
  readonly name: string;
  readonly tier: LibraryTier;
}

interface ProjectSourceRow {
  readonly library_id: string;
  readonly name: string;
  readonly tier: LibraryTier;
  readonly priority: number;
}

/** A project source library is invalid (unknown id or non-master tier) → 422. */
export class InvalidSourceLibraryError extends DatabaseError {}

export interface ProjectSource {
  readonly libraryId: string;
  readonly name: string;
  readonly tier: LibraryTier;
  readonly priority: number;
}

export interface ProjectListItem {
  readonly id: string;
  readonly name: string;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  /** Associated client (ADR-054), or null when the project has no client. */
  readonly clientId: string | null;
  /** Associated client's name, denormalized for list ergonomics; null when unassociated. */
  readonly clientName: string | null;
  readonly sources: readonly ProjectSource[];
}

export interface ProjectTocEntry {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

export interface ProjectWithToc {
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sources: readonly ProjectSource[];
  readonly toc: readonly ProjectTocEntry[];
  /** Soft-delete tombstone (ADR-031). NULL on an active project. ISO-8601. */
  readonly deletedAt: string | null;
  /** Caller-supplied actor that soft-deleted the project. NULL when active. */
  readonly deletedBy: string | null;
  /** Default section-number display format for generate requests. */
  readonly sectionNumberFormat: SectionNumberFormat;
}

/** Result of a soft-delete (ADR-031) — the persisted tombstone. Idempotent:
 *  re-deleting returns the EXISTING values, never overwriting them. */
export interface ProjectTombstone {
  readonly projectId: string;
  readonly deletedAt: string;
  readonly deletedBy: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
  readonly sourceLibraryIds: readonly string[];
}

/** Sources must be company or client masters (ADR-015 D3) — reference-tier
 *  content must first be derived into a company master. Returned in input
 *  order (= priority order). */
async function validateSourceLibraries(
  ids: readonly string[],
  pool: Queryable
): Promise<readonly SourceLibRow[]> {
  const res = await pool.query<SourceLibRow>(
    `SELECT id, name, tier FROM libraries WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(res.rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const lib = byId.get(id);
    if (!lib) {
      // User-facing via the 422 surface — no internal function-name prefix.
      throw new InvalidSourceLibraryError(`source library ${id} not found`);
    }
    if (lib.tier !== 'company' && lib.tier !== 'client') {
      throw new InvalidSourceLibraryError(
        `library "${lib.name}" is ${lib.tier}-tier — project sources must be company or client masters`
      );
    }
    return lib;
  });
}

export async function createProject(
  input: CreateProjectInput,
  pool: Queryable
): Promise<ProjectSummary> {
  try {
    const libs = await validateSourceLibraries(input.sourceLibraryIds, pool);
    const result = await pool.query<ProjectRow>(
      `WITH proj AS (
         INSERT INTO projects (name, description) VALUES ($1, $2)
         RETURNING id, name, description
       ),
       src AS (
         INSERT INTO project_sources (project_id, library_id, priority)
         SELECT proj.id, u.lib_id, u.ord::int
         FROM proj, unnest($3::uuid[]) WITH ORDINALITY AS u(lib_id, ord)
       )
       SELECT id, name, description FROM proj`,
      [input.name, input.description ?? null, input.sourceLibraryIds]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createProject: no row returned after insert');
    const sources = libs.map((lib, i) => ({
      libraryId: lib.id,
      name: lib.name,
      tier: lib.tier,
      priority: i + 1,
    }));
    // A newly created project has no client association (set later via PATCH /projects).
    return {
      projectId: row.id,
      name: row.name,
      description: row.description,
      clientId: null,
      clientName: null,
      sources,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('createProject: insert failed', { cause: err });
  }
}

/**
 * Replaces a project's ordered source-library list (priority = array order).
 * Sources are validated (company/client tier, ADR-015 D3) before a transactional
 * delete+reinsert — the two `project_sources` unique constraints rule out a
 * single-statement CTE. Returns the new sources. Re-ordering does NOT re-resolve
 * already-derived specs (copies are immutable, ADR-015 D2).
 */
export async function setProjectSources(
  projectId: string,
  sourceLibraryIds: readonly string[],
  pool: Pool
): Promise<readonly ProjectSource[]> {
  // validation + connect live inside the try so every failure path (incl. a
  // failed connect) goes through one DatabaseError surface. InvalidSourceLibraryError
  // extends DatabaseError, so it still re-throws unwrapped → 422 at the handler.
  let client: PoolClient | null = null;
  try {
    const libs = await validateSourceLibraries(sourceLibraryIds, pool);
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM project_sources WHERE project_id = $1', [projectId]);
    await client.query(
      `INSERT INTO project_sources (project_id, library_id, priority)
       SELECT $1, u.lib_id, u.ord::int
       FROM unnest($2::uuid[]) WITH ORDINALITY AS u(lib_id, ord)`,
      [projectId, sourceLibraryIds]
    );
    await client.query('COMMIT');
    return libs.map((lib, i) => ({
      libraryId: lib.id,
      name: lib.name,
      tier: lib.tier,
      priority: i + 1,
    }));
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* best-effort */
      }
    }
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`setProjectSources: replace failed for ${projectId}`, { cause: err });
  } finally {
    if (client) client.release();
  }
}

export async function listProjects(pool: Queryable): Promise<readonly ProjectListItem[]> {
  try {
    // Soft-deleted projects (ADR-031) are hidden from the listing — they remain
    // GET-able by id (with the tombstone surfaced) and reversible via restore.
    const result = await pool.query<ProjectListRow>(
      'SELECT id, name FROM projects WHERE deleted_at IS NULL ORDER BY name, id'
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name }));
  } catch (err) {
    throw new DatabaseError('listProjects: query failed', { cause: err });
  }
}

function mapSources(rows: readonly ProjectSourceRow[]): readonly ProjectSource[] {
  return rows.map((row) => ({
    libraryId: row.library_id,
    name: row.name,
    tier: row.tier,
    priority: row.priority,
  }));
}

async function fetchProjectTocAndSources(
  project: ProjectRow,
  id: string,
  pool: Queryable
): Promise<ProjectWithToc> {
  const tocRes = await pool.query<TocRow>(
    `SELECT s.id, s.section, s.title, ps.position
     FROM project_specs ps
     JOIN specs s ON s.id = ps.spec_id
     WHERE ps.project_id = $1
     ORDER BY ps.position`,
    [id]
  );
  const srcRes = await pool.query<ProjectSourceRow>(
    `SELECT ps.library_id, l.name, l.tier, ps.priority
     FROM project_sources ps
     JOIN libraries l ON l.id = ps.library_id
     WHERE ps.project_id = $1
     ORDER BY ps.priority`,
    [id]
  );
  return {
    projectId: project.id,
    name: project.name,
    description: project.description,
    toc: tocRes.rows.map((row) => ({
      specId: row.id,
      section: row.section,
      title: row.title,
      position: row.position,
    })),
    sources: mapSources(srcRes.rows),
    deletedAt: project.deleted_at ? project.deleted_at.toISOString() : null,
    deletedBy: project.deleted_by,
    sectionNumberFormat: parseSectionNumberFormat(project.section_number_format),
  };
}

export async function findProjectById(id: string, pool: Queryable): Promise<ProjectWithToc | null> {
  let project: ProjectRow | undefined;
  try {
    // A soft-deleted project (ADR-031) is still returned here — only listings
    // hide it — so lineage/history and a restore decision still resolve.
    const res = await pool.query<ProjectRow>(
      'SELECT id, name, description, deleted_at, deleted_by, section_number_format FROM projects WHERE id = $1',
      [id]
    );
    project = res.rows[0];
  } catch (err) {
    throw new DatabaseError(`findProjectById: query failed for ${id}`, { cause: err });
  }
  if (!project) return null;
  try {
    return await fetchProjectTocAndSources(project, id, pool);
  } catch (err) {
    throw new DatabaseError(`findProjectById: toc query failed for ${id}`, { cause: err });
  }
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly sectionNumberFormat?: SectionNumberFormat;
  /** Absent = leave association unchanged; null = disassociate; uuid = associate (ADR-054). */
  readonly clientId?: string | null;
}

export interface UpdateProjectResult {
  readonly id: string;
  readonly name: string;
  readonly sectionNumberFormat: SectionNumberFormat;
  readonly clientId: string | null;
}

interface UpdateProjectRow {
  readonly id: string;
  readonly name: string;
  readonly section_number_format: string;
  readonly client_id: string | null;
}

/** Build the ordered SET clauses + params for the provided fields (id is always $1). */
function buildProjectUpdate(
  id: string,
  input: UpdateProjectInput
): { setClauses: string[]; params: (string | null)[] } {
  const setClauses: string[] = ['updated_at = now()'];
  const params: (string | null)[] = [id];
  if (input.name !== undefined) {
    params.push(input.name);
    setClauses.push(`name = $${params.length}`);
  }
  if (input.sectionNumberFormat !== undefined) {
    params.push(input.sectionNumberFormat);
    setClauses.push(`section_number_format = $${params.length}`);
  }
  if (input.clientId !== undefined) {
    params.push(input.clientId);
    setClauses.push(`client_id = $${params.length}`);
  }
  return { setClauses, params };
}

/**
 * Partial update of a project's mutable settings. At least one field must be
 * provided; only provided fields are SET. A non-null `clientId` is validated to
 * exist first (→ ClientNotFoundError → 422), so an unknown client is a clean 422
 * rather than a raw FK error; `clientId: null` disassociates. Returns null when
 * the project does not exist (→ 404 at the handler).
 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  pool: Queryable
): Promise<UpdateProjectResult | null> {
  const { setClauses, params } = buildProjectUpdate(id, input);
  const sql = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id, name, section_number_format, client_id`;
  try {
    if (typeof input.clientId === 'string') await assertClientExists(input.clientId, pool);
    const { rows } = await pool.query<UpdateProjectRow>(sql, params);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      sectionNumberFormat: parseSectionNumberFormat(row.section_number_format),
      clientId: row.client_id,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    const wrapped = new DatabaseError(`updateProject: update failed for ${id}`, { cause: err });
    // TOCTOU: assertClientExists passed, but the client can be deleted before this
    // UPDATE runs; the ON DELETE RESTRICT FK then raises 23503. Map it to the same
    // clean 422 (ClientNotFoundError) as the fast-path check, never a generic 500.
    if (typeof input.clientId === 'string' && getPgCode(wrapped) === '23503') {
      throw new ClientNotFoundError(`client ${input.clientId} not found`, { cause: err });
    }
    throw wrapped;
  }
}

/**
 * Soft-delete a project (ADR-031): tombstone it with `deleted_at = now()` and
 * the caller-supplied `deleted_by` actor. **Idempotent** — `COALESCE` preserves
 * an existing tombstone, so re-deleting an already-deleted project returns the
 * ORIGINAL who/when, never overwriting them. Returns null when the project does
 * not exist (→ 404 at the handler).
 */
export async function softDeleteProject(
  id: string,
  deletedBy: string,
  pool: Queryable
): Promise<ProjectTombstone | null> {
  try {
    const { rows } = await pool.query<{ deleted_at: Date; deleted_by: string }>(
      `UPDATE projects
       SET deleted_at = COALESCE(deleted_at, now()),
           deleted_by = COALESCE(deleted_by, $2),
           updated_at = CASE WHEN deleted_at IS NULL THEN now() ELSE updated_at END
       WHERE id = $1
       RETURNING deleted_at, deleted_by`,
      [id, deletedBy]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      projectId: id,
      deletedAt: row.deleted_at.toISOString(),
      deletedBy: row.deleted_by,
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`softDeleteProject: update failed for ${id}`, { cause: err });
  }
}

/**
 * Restore a soft-deleted project (ADR-031): clear the tombstone. **Idempotent** —
 * restoring an already-active project is a no-op that still returns 200. Returns
 * null when the project does not exist (→ 404 at the handler).
 */
export async function restoreProject(
  id: string,
  pool: Queryable
): Promise<{ projectId: string } | null> {
  try {
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE projects
       SET deleted_at = NULL,
           deleted_by = NULL,
           updated_at = CASE WHEN deleted_at IS NOT NULL THEN now() ELSE updated_at END
       WHERE id = $1
       RETURNING id`,
      [id]
    );
    const row = rows[0];
    if (!row) return null;
    return { projectId: row.id };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`restoreProject: update failed for ${id}`, { cause: err });
  }
}
