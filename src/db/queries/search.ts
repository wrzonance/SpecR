// src/db/queries/search.ts
import { pool, DatabaseError } from '../index.js';
import { buildParagraphSearch } from './search-query.js';
import type { ParagraphSearchOptions, ParagraphSearchResult } from './search-query.js';

export type { ParagraphSearchOptions, ParagraphSearchResult } from './search-query.js';

export interface SpecSectionResult {
  readonly section: string;
  readonly title: string;
  readonly division: string;
  readonly inDatabase: boolean;
}

/**
 * Omit-undefined constructor for {@link ParagraphSearchOptions}. Under
 * `exactOptionalPropertyTypes` an optional prop may be absent but not explicitly
 * `undefined`, so the REST/MCP layers — which hold validated-but-optional fields —
 * route through this to build the options object without leaking `undefined`.
 */
export function toSearchOptions(input: {
  readonly libraryId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly division?: string | undefined;
  readonly part?: number | undefined;
  readonly nodeType?: string | undefined;
  readonly limit?: number | undefined;
}): ParagraphSearchOptions {
  return {
    ...(input.libraryId !== undefined ? { libraryId: input.libraryId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.division !== undefined ? { division: input.division } : {}),
    ...(input.part !== undefined ? { part: input.part } : {}),
    ...(input.nodeType !== undefined ? { nodeType: input.nodeType } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

/**
 * Ranked full-text paragraph search (ADR-062): `websearch_to_tsquery` + `ts_rank_cd`
 * + `ts_headline`, scoped by library/project/division/part/nodeType. A blank query
 * returns `[]`; a degenerate (no-lexeme) query falls back to an ILIKE substring scan.
 */
export async function searchParagraphs(
  query: string,
  options: ParagraphSearchOptions = {}
): Promise<ParagraphSearchResult[]> {
  if (query.trim() === '') return [];
  try {
    const { sql, params } = buildParagraphSearch(query, options);
    const result = await pool.query<ParagraphSearchResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('searchParagraphs failed', { cause: err });
  }
}

export async function listSpecSections(division?: string): Promise<SpecSectionResult[]> {
  try {
    const whereClause = division !== undefined ? ` WHERE cs.division = $1` : '';
    const params: unknown[] = division !== undefined ? [division] : [];

    const sql = `
      SELECT cs.section_number AS section, cs.title, cs.division,
             (s.id IS NOT NULL) AS "inDatabase"
      FROM spec_sections cs
      LEFT JOIN specs s ON s.section = cs.section_number${whereClause}
      ORDER BY cs.section_number`;

    const result = await pool.query<SpecSectionResult>(sql, params);
    return result.rows;
  } catch (err) {
    throw new DatabaseError('listSpecSections failed', { cause: err });
  }
}

export async function lookupSpecSectionTitle(sectionNumber: string): Promise<string | null> {
  try {
    const result = await pool.query<{ title: string }>(
      `SELECT title FROM spec_sections WHERE section_number = $1 LIMIT 1`,
      [sectionNumber]
    );
    return result.rows[0]?.title ?? null;
  } catch (err) {
    throw new DatabaseError('lookupSpecSectionTitle failed', { cause: err });
  }
}
