import { DatabaseError } from '../errors.js';
import type { Pool, PoolClient } from 'pg';
import type { LibraryTier } from './libraries.js';

interface Queryable {
  query: Pool['query'];
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
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

interface BrokenRefRow {
  readonly id: string;
  readonly source_spec_id: string;
  readonly source_spec_section: string;
  readonly target_spec_section: string | null;
  readonly reference_text: string;
  readonly available_from: readonly { libraryId: string; name: string }[] | null;
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
}

export interface BrokenRef {
  readonly refId: string;
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly targetSpecSection: string | null;
  readonly referenceText: string;
  /** Project source libraries that hold the missing target section — the
   *  actionable "add this section" advisory (design doc #94). Priority order. */
  readonly availableFrom: readonly { libraryId: string; name: string }[];
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
    const result = await pool.query<ProjectListRow>(
      'SELECT id, name FROM projects ORDER BY name, id'
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

export async function findProjectById(id: string, pool: Queryable): Promise<ProjectWithToc | null> {
  let project: ProjectRow | undefined;
  try {
    const res = await pool.query<ProjectRow>(
      'SELECT id, name, description FROM projects WHERE id = $1',
      [id]
    );
    project = res.rows[0];
  } catch (err) {
    throw new DatabaseError(`findProjectById: query failed for ${id}`, { cause: err });
  }
  if (!project) return null;
  try {
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
    };
  } catch (err) {
    throw new DatabaseError(`findProjectById: toc query failed for ${id}`, { cause: err });
  }
}

export async function updateProjectName(
  id: string,
  name: string,
  pool: Queryable
): Promise<{ id: string; name: string } | null> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `UPDATE projects SET name = $2, updated_at = now() WHERE id = $1 RETURNING id, name`,
    [id, name]
  );
  return rows[0] ?? null;
}

export async function getBrokenRefs(
  projectId: string,
  pool: Queryable
): Promise<readonly BrokenRef[]> {
  try {
    const result = await pool.query<BrokenRefRow>(
      `SELECT sr.id, sr.source_spec_id, s.section AS source_spec_section,
              sr.target_spec_section, sr.reference_text,
              (SELECT json_agg(json_build_object('libraryId', l.id, 'name', l.name)
                               ORDER BY pso.priority)
               FROM project_sources pso
               JOIN libraries l ON l.id = pso.library_id
               WHERE pso.project_id = $1
                 AND EXISTS (SELECT 1 FROM specs ms
                             WHERE ms.library_id = pso.library_id
                               AND ms.section = sr.target_spec_section)) AS available_from
       FROM spec_references sr
       JOIN specs s ON s.id = sr.source_spec_id
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id AND ps.project_id = $1
       WHERE sr.is_broken = true`,
      [projectId]
    );
    return result.rows.map((row) => ({
      refId: row.id,
      sourceSpecId: row.source_spec_id,
      sourceSpecSection: row.source_spec_section,
      targetSpecSection: row.target_spec_section,
      referenceText: row.reference_text,
      availableFrom: row.available_from ?? [],
    }));
  } catch (err) {
    throw new DatabaseError(`getBrokenRefs: query failed for project ${projectId}`, { cause: err });
  }
}
