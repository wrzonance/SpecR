import { DatabaseError } from '../errors.js';
import type { Pool } from 'pg';
import { buildSnippet } from './snippet.js';

interface Queryable {
  query: Pool['query'];
}

interface BrokenRefRow {
  readonly id: string;
  readonly source_spec_id: string;
  readonly source_spec_section: string;
  readonly source_paragraph_id: string;
  readonly source_paragraph_text: string;
  readonly target_spec_section: string | null;
  readonly reference_text: string;
  readonly available_from: readonly { libraryId: string; name: string }[] | null;
}

export interface BrokenRef {
  readonly refId: string;
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  /** Paragraph the reference sits in — the paragraph-level locator (issue #260). */
  readonly sourceParagraphId: string;
  /** Short excerpt of that paragraph, centred on the matched reference (#260). */
  readonly snippet: string;
  readonly targetSpecSection: string | null;
  readonly referenceText: string;
  /** Project source libraries that hold the missing target section — the
   *  actionable "add this section" advisory (design doc #94). Priority order. */
  readonly availableFrom: readonly { libraryId: string; name: string }[];
}

export async function getBrokenRefs(
  projectId: string,
  pool: Queryable
): Promise<readonly BrokenRef[]> {
  try {
    const result = await pool.query<BrokenRefRow>(
      `SELECT sr.id, sr.source_spec_id, s.section AS source_spec_section,
              sr.source_paragraph_id, p.text AS source_paragraph_text,
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
       JOIN paragraphs p ON p.id = sr.source_paragraph_id
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id AND ps.project_id = $1
       WHERE sr.is_broken = true`,
      [projectId]
    );
    return result.rows.map((row) => ({
      refId: row.id,
      sourceSpecId: row.source_spec_id,
      sourceSpecSection: row.source_spec_section,
      sourceParagraphId: row.source_paragraph_id,
      snippet: buildSnippet(row.source_paragraph_text, row.reference_text),
      targetSpecSection: row.target_spec_section,
      referenceText: row.reference_text,
      availableFrom: row.available_from ?? [],
    }));
  } catch (err) {
    throw new DatabaseError(`getBrokenRefs: query failed for project ${projectId}`, { cause: err });
  }
}
