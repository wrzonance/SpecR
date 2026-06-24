import { DatabaseError } from '../errors.js';
import type { Pool, PoolClient } from 'pg';
import type { LibraryTier } from './libraries.js';
import { SECTION_NUMBER_FORMATS } from '../../lib/section-number.js';
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
    return { projectId: row.id, name: row.name, description: row.description, sources };
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

function parseSectionNumberFormat(raw: string): SectionNumberFormat {
  return (SECTION_NUMBER_FORMATS as readonly string[]).includes(raw)
    ? (raw as SectionNumberFormat)
    : 'canonical';
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

/**
 * Resolve the section-number format to fall back to for a stored spec when a
 * generate request omits it (issue #267). A spec reaches a project only via
 * `project_specs`, and may belong to zero, one, or several projects — so a
 * project default is only well-defined when the spec belongs to EXACTLY ONE
 * project. Zero projects (orphan spec) or two-plus (no unambiguous owner) both
 * return null, letting the caller fall through to the canonical default rather
 * than picking an arbitrary project's format.
 */
export async function findSoleProjectSectionNumberFormat(
  specId: string,
  pool: Queryable
): Promise<SectionNumberFormat | null> {
  try {
    // One row per active project the spec belongs to. We fetch the (at most a
    // few) matches and decide sole-ownership in code — clearer than a HAVING
    // over a window function, and the result set is tiny.
    const { rows } = await pool.query<{ section_number_format: string }>(
      `SELECT DISTINCT p.id, p.section_number_format
       FROM projects p
       JOIN project_specs ps ON ps.project_id = p.id
       WHERE ps.spec_id = $1 AND p.deleted_at IS NULL`,
      [specId]
    );
    const row = rows[0];
    return rows.length === 1 && row ? parseSectionNumberFormat(row.section_number_format) : null;
  } catch (err) {
    throw new DatabaseError(`findSoleProjectSectionNumberFormat: query failed for spec ${specId}`, {
      cause: err,
    });
  }
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly sectionNumberFormat?: SectionNumberFormat;
}

export interface UpdateProjectResult {
  readonly id: string;
  readonly name: string;
  readonly sectionNumberFormat: SectionNumberFormat;
}

/**
 * Partial update of a project's mutable settings. At least one field must be
 * provided; only provided fields are SET. Returns null when the project does
 * not exist (→ 404 at the handler).
 */
export async function updateProject(
  id: string,
  input: UpdateProjectInput,
  pool: Queryable
): Promise<UpdateProjectResult | null> {
  const setClauses: string[] = ['updated_at = now()'];
  const params: string[] = [id];
  if (input.name !== undefined) {
    params.push(input.name);
    setClauses.push(`name = $${params.length}`);
  }
  if (input.sectionNumberFormat !== undefined) {
    params.push(input.sectionNumberFormat);
    setClauses.push(`section_number_format = $${params.length}`);
  }
  const sql = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id, name, section_number_format`;
  try {
    const { rows } = await pool.query<{
      id: string;
      name: string;
      section_number_format: string;
    }>(sql, params);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      sectionNumberFormat: parseSectionNumberFormat(row.section_number_format),
    };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`updateProject: update failed for ${id}`, { cause: err });
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
