import { pool, DatabaseError } from '../index.js';

export interface ParagraphSearchResult {
  readonly paragraphId: string;
  readonly text: string;
  readonly nodeType: string;
  readonly specId: string;
  readonly specSection: string;
  readonly specTitle: string;
}

export interface CsiSectionResult {
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
    const params: unknown[] = [`%${query}%`, limit];
    let sql = `
      SELECT p.id AS "paragraphId", p.text, p.node_type AS "nodeType",
             s.id AS "specId",
             COALESCE(s.section, '') AS "specSection",
             COALESCE(s.title, '') AS "specTitle"
      FROM paragraphs p
      JOIN specs s ON p.spec_id = s.id
      WHERE p.text ILIKE $1`;
    if (division !== undefined) {
      params.push(`${division} %`);
      sql += ` AND s.section LIKE $${params.length}`;
    }
    sql += ` ORDER BY s.section, p.position LIMIT $2`;

    const result = await pool.query<ParagraphSearchResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('searchParagraphs failed', { cause: err });
  }
}

export async function listCsiSections(division?: string): Promise<CsiSectionResult[]> {
  try {
    const params: unknown[] = [];
    let sql = `
      SELECT cs.section_number AS section, cs.title, cs.division,
             (s.id IS NOT NULL) AS "inDatabase"
      FROM csi_sections cs
      LEFT JOIN specs s ON s.section = cs.section_number`;
    if (division !== undefined) {
      params.push(division);
      sql += ` WHERE cs.division = $1`;
    }
    sql += ` ORDER BY cs.section_number`;

    const result = await pool.query<CsiSectionResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('listCsiSections failed', { cause: err });
  }
}
