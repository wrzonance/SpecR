import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';

interface Queryable {
  query: Pool['query'];
}

// A keynote valid for a project (ADR-016 D2): a master keynote whose source
// library feeds the project and whose target section is present in the project
// TOC. `id`/`libraryId` carry the master's identity through to consumers; the
// Revit keynote table (#99, out of scope here) renders code/description/parentCode.
export interface ProjectKeynote {
  readonly id: string;
  readonly libraryId: string;
  readonly code: string;
  readonly parentCode: string | null;
  readonly description: string;
  readonly targetSection: string;
  readonly targetParagraphId: string | null;
}

interface ProjectKeynoteRow {
  readonly id: string;
  readonly library_id: string;
  readonly code: string;
  readonly parent_code: string | null;
  readonly description: string;
  readonly target_section: string;
  readonly target_paragraph_id: string | null;
}

function mapRow(row: ProjectKeynoteRow): ProjectKeynote {
  return {
    id: row.id,
    libraryId: row.library_id,
    code: row.code,
    parentCode: row.parent_code,
    description: row.description,
    targetSection: row.target_section,
    targetParagraphId: row.target_paragraph_id,
  };
}

/**
 * Valid keynotes for a project, computed as a filter — never a copy (ADR-016 D2).
 *
 * A keynote qualifies when (a) its library feeds the project (`project_sources`)
 * and (b) its `target_section` is present in the project TOC (`project_specs`).
 * A keynote pointing at a section the manual does not contain is excluded — the
 * coordination-error case the keynoting engine exists to prevent.
 *
 * `code` is the key of a Revit keynote table, so a code carried by two source
 * libraries is resolved to one row by source priority (lowest `priority` wins —
 * the ADR-015 copy-on-derive order). Output is ordered by `code` for a
 * deterministic, directly-renderable result. An unknown project has no sources
 * and no TOC, so it yields `[]` — the 404 is the API caller's concern (#99).
 */
export async function getProjectKeynotes(
  projectId: string,
  db: Queryable = pool
): Promise<readonly ProjectKeynote[]> {
  try {
    const result = await db.query<ProjectKeynoteRow>(
      `SELECT DISTINCT ON (k.code)
              k.id, k.library_id, k.code, k.parent_code,
              k.description, k.target_section, k.target_paragraph_id
         FROM keynotes k
         JOIN project_sources src ON src.library_id = k.library_id
        WHERE src.project_id = $1
          AND k.target_section IN (
                SELECT s.section
                  FROM project_specs ps
                  JOIN specs s ON s.id = ps.spec_id
                 WHERE ps.project_id = $1
              )
        ORDER BY k.code, src.priority`,
      [projectId]
    );
    return result.rows.map(mapRow);
  } catch (err) {
    throw new DatabaseError(`getProjectKeynotes: query failed for project ${projectId}`, {
      cause: err,
    });
  }
}
