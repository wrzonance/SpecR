import type { Pool } from 'pg';
import { DatabaseError } from '../index.js';
import { resolveEffectiveRules, disciplineForSection } from './disciplines.js';

interface Queryable {
  query: Pool['query'];
}

interface TocRow {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
}

/** A project spec-listing row: a TOC entry plus its resolved discipline (ADR-065). */
export interface ProjectSpec {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly position: number;
  readonly discipline: string | null;
}

/** Optional filters for a project's spec listing. */
export interface ProjectSpecListOptions {
  /** Keep only specs whose resolved discipline key equals this value. */
  readonly discipline?: string;
}

/**
 * List a project's specs (its table-of-contents rows) with each row's resolved discipline
 * (ADR-065). Project copies belong to no single library, and a project may draw from several,
 * so disciplines resolve against the built-in default mapping. Pass `discipline` to keep only
 * specs resolving to that key. The project's existence (and 404) is the caller's concern.
 */
export async function listProjectSpecs(
  projectId: string,
  options: ProjectSpecListOptions,
  db: Queryable
): Promise<readonly ProjectSpec[]> {
  try {
    const result = await db.query<TocRow>(
      `SELECT s.id, s.section, s.title, ps.position
         FROM project_specs ps
         JOIN specs s ON s.id = ps.spec_id
        WHERE ps.project_id = $1
        ORDER BY ps.position`,
      [projectId]
    );
    const rules = await resolveEffectiveRules(undefined, db);
    const specs = result.rows.map((row) => ({
      specId: row.id,
      section: row.section,
      title: row.title,
      position: row.position,
      discipline: disciplineForSection(row.section, rules),
    }));
    const { discipline } = options;
    return discipline === undefined ? specs : specs.filter((s) => s.discipline === discipline);
  } catch (err) {
    throw new DatabaseError(`listProjectSpecs: query failed for project ${projectId}`, {
      cause: err,
    });
  }
}
