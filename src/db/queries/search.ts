// src/db/queries/search.ts
import { pool, DatabaseError } from '../index.js';

export interface ParagraphSearchResult {
  readonly paragraphId: string;
  readonly text: string;
  readonly nodeType: string;
  readonly specId: string;
  readonly specSection: string;
  readonly specTitle: string;
}

export interface SpecSectionResult {
  readonly section: string;
  readonly title: string;
  readonly division: string;
  readonly inDatabase: boolean;
}

export async function searchParagraphs(
  query: string,
  division?: string,
  limit = 20
): Promise<ParagraphSearchResult[]> {
  try {
    const divisionClause = division !== undefined ? ` AND s.section LIKE $3` : '';
    const params: unknown[] =
      division !== undefined ? [`%${query}%`, limit, `${division} %`] : [`%${query}%`, limit];

    const sql = `
      SELECT p.id AS "paragraphId", p.text, p.node_type AS "nodeType",
             s.id AS "specId",
             COALESCE(s.section, '') AS "specSection",
             COALESCE(s.title, '') AS "specTitle"
      FROM paragraphs p
      JOIN specs s ON p.spec_id = s.id
      WHERE p.text ILIKE $1${divisionClause}
      ORDER BY s.section, p.position LIMIT $2`;

    const result = await pool.query<ParagraphSearchResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('searchParagraphs failed', { cause: err });
  }
}

export async function listCsiSections(division?: string): Promise<SpecSectionResult[]> {
  try {
    const whereClause = division !== undefined ? ` WHERE cs.division = $1` : '';
    const params: unknown[] = division !== undefined ? [division] : [];

    const sql = `
      SELECT cs.section_number AS section, cs.title, cs.division,
             (s.id IS NOT NULL) AS "inDatabase"
      FROM csi_sections cs
      LEFT JOIN specs s ON s.section = cs.section_number${whereClause}
      ORDER BY cs.section_number`;

    const result = await pool.query<SpecSectionResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('listCsiSections failed', { cause: err });
  }
}

export async function lookupCsiSectionTitle(sectionNumber: string): Promise<string | null> {
  try {
    const result = await pool.query<{ title: string }>(
      `SELECT title FROM csi_sections WHERE section_number = $1 LIMIT 1`,
      [sectionNumber]
    );
    return result.rows[0]?.title ?? null;
  } catch (err) {
    throw new DatabaseError('lookupCsiSectionTitle failed', { cause: err });
  }
}
