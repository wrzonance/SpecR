import { DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
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
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly description: string | null;
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
  readonly toc: readonly ProjectTocEntry[];
}

export interface BrokenRef {
  readonly refId: string;
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly targetSpecSection: string | null;
  readonly referenceText: string;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string;
}

export interface AddSpecResult {
  readonly specId: string;
  readonly position: number;
}

export async function createProject(
  input: CreateProjectInput,
  pool: Queryable
): Promise<ProjectSummary> {
  try {
    const result = await pool.query<ProjectRow>(
      `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id, name, description`,
      [input.name, input.description ?? null]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createProject: no row returned after insert');
    return { projectId: row.id, name: row.name, description: row.description };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('createProject: insert failed', { cause: err });
  }
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
    };
  } catch (err) {
    throw new DatabaseError(`findProjectById: toc query failed for ${id}`, { cause: err });
  }
}

export async function addSpecToProject(
  projectId: string,
  specId: string,
  pool: Queryable
): Promise<AddSpecResult> {
  try {
    const result = await pool.query<{ spec_id: string; position: number }>(
      `WITH spec_section AS (
         SELECT section FROM specs WHERE id = $2
       ),
       inserted AS (
         INSERT INTO project_specs (project_id, spec_id, position)
         SELECT $1, $2, COALESCE(MAX(position), 0) + 1 FROM project_specs WHERE project_id = $1
         RETURNING spec_id, position
       ),
       repaired AS (
         UPDATE spec_references sr
         SET target_spec_id = $2, is_broken = false
         FROM project_specs ps, spec_section ss
         WHERE sr.target_spec_section = ss.section
           AND sr.is_broken = true
           AND sr.source_spec_id = ps.spec_id
           AND ps.project_id = $1
           AND EXISTS (SELECT 1 FROM inserted)
       )
       SELECT spec_id, position FROM inserted`,
      [projectId, specId]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('addSpecToProject: no row returned after insert');
    logger.info({ projectId, specId, position: row.position }, 'addSpecToProject: spec added');
    return { specId: row.spec_id, position: row.position };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`addSpecToProject: failed for spec ${specId}`, { cause: err });
  }
}

export async function removeSpecFromProject(
  projectId: string,
  specId: string,
  pool: Queryable
): Promise<boolean> {
  try {
    const result = await pool.query<{ deleted_count: number }>(
      `WITH deleted AS (
         DELETE FROM project_specs WHERE project_id = $1 AND spec_id = $2 RETURNING spec_id
       ),
       mark_broken AS (
         UPDATE spec_references sr
         SET is_broken = true
         FROM project_specs ps
         WHERE sr.target_spec_id = $2
           AND sr.source_spec_id = ps.spec_id
           AND ps.project_id = $1
           AND sr.source_spec_id <> $2
           AND EXISTS (SELECT 1 FROM deleted)
       )
       SELECT COUNT(*)::int AS deleted_count FROM deleted`,
      [projectId, specId]
    );
    const count = result.rows[0]?.deleted_count ?? 0;
    if (count === 0) return false;
  } catch (err) {
    throw new DatabaseError(`removeSpecFromProject: failed for spec ${specId}`, { cause: err });
  }
  logger.info({ projectId, specId }, 'removeSpecFromProject: spec removed, refs marked broken');
  return true;
}

export async function getBrokenRefs(
  projectId: string,
  pool: Queryable
): Promise<readonly BrokenRef[]> {
  try {
    const result = await pool.query<BrokenRefRow>(
      `SELECT sr.id, sr.source_spec_id, s.section AS source_spec_section,
              sr.target_spec_section, sr.reference_text
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
    }));
  } catch (err) {
    throw new DatabaseError(`getBrokenRefs: query failed for project ${projectId}`, { cause: err });
  }
}
