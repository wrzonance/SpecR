// src/db/queries/search-query.ts
// Pure SQL builder for ranked full-text paragraph search (#445, ADR-062). Emits a
// parameterized query text + params array; the executor in search.ts runs it.
// No I/O; the only mutation is appending bound values to the params array it owns.

export interface ParagraphSearchResult {
  readonly paragraphId: string;
  readonly text: string;
  readonly nodeType: string;
  readonly specId: string;
  readonly specSection: string;
  readonly specTitle: string;
  /**
   * ts_headline excerpt with matched lexemes wrapped in <mark>…</mark>. The source
   * paragraph text is HTML-escaped before the tags are inserted, so <mark> is the
   * only live markup — safe for a consumer to render as HTML.
   */
  readonly snippet: string;
  /** ts_rank_cd cover-density score; 0 on the degenerate ILIKE fallback path. */
  readonly rank: number;
}

export interface ParagraphSearchOptions {
  readonly libraryId?: string;
  readonly projectId?: string;
  /** 2-digit CSI division, e.g. "27" — matches section "27 …". */
  readonly division?: string;
  /** CSI PART ordinal: 1 = General, 2 = Products, 3 = Execution. */
  readonly part?: number;
  readonly nodeType?: string;
  readonly limit?: number;
}

export interface BuiltQuery {
  readonly sql: string;
  readonly params: unknown[];
}

const DEFAULT_LIMIT = 20;

// ts_headline highlight tags + fragment sizing. <mark> is neutral: a UI can style
// it, an agent can strip it. Constant (no user input) — safe to inline into SQL.
const HEADLINE_OPTS = 'StartSel=<mark>, StopSel=</mark>, MaxWords=28, MinWords=12, ShortWord=3';

// Escape LIKE metacharacters so the degenerate-query ILIKE fallback treats the user
// text literally (no %/_ wildcard injection); paired with ESCAPE '\' in the SQL.
function likePattern(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

// Postgres core has no HTML-escape, and both ts_headline and the substring fallback
// return the source text verbatim. `snippet` carries <mark> tags and is meant to
// render as HTML, so escape &,<,> in the paragraph text FIRST — otherwise uploaded
// content like `<img onerror=…>` becomes live markup (stored XSS) in any consumer.
// ts_headline inserts the literal <mark> StartSel/StopSel afterward, so they stay
// intact. Order matters: & before < and > so the introduced entities aren't re-escaped.
function htmlEscapeSql(expr: string): string {
  return `replace(replace(replace(${expr}, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')`;
}

// Column-predicate scope filters (library / project / division / nodeType). Appends
// bound params to `params` and returns the SQL fragments. `part` is handled by
// partFragments — it needs a recursive ancestor walk, not a column predicate.
function scopeClauses(options: ParagraphSearchOptions, params: unknown[]): string[] {
  const clauses: string[] = [];
  const add = (value: unknown, clause: (n: number) => string): void => {
    params.push(value);
    clauses.push(clause(params.length));
  };
  if (options.division !== undefined) add(`${options.division} %`, (n) => `s.section LIKE $${n}`);
  if (options.libraryId !== undefined) add(options.libraryId, (n) => `s.library_id = $${n}`);
  if (options.projectId !== undefined) add(options.projectId, (n) => `s.project_id = $${n}`);
  if (options.nodeType !== undefined) add(options.nodeType, (n) => `p.node_type = $${n}`);
  return clauses;
}

interface PartFragments {
  readonly ctes: string;
  readonly join: string;
  readonly where: string;
}

// The CSI-PART filter. There is no stored part pointer, so we climb each hit up to
// its root paragraph (parent_id IS NULL), then rank the spec's root parts by
// document order to get the 1-based PART ordinal, and keep only the requested part.
function partFragments(options: ParagraphSearchOptions, params: unknown[]): PartFragments {
  if (options.part === undefined) return { ctes: '', join: '', where: '' };
  params.push(options.part);
  const partParam = params.length;
  const ctes = `,
    climb AS (
      SELECT id AS hit_id, parent_id, id AS cur_id FROM hits
      UNION ALL
      SELECT c.hit_id, pp.parent_id, pp.id
      FROM climb c JOIN paragraphs pp ON pp.id = c.parent_id
    ),
    root_of AS (SELECT hit_id, cur_id AS root_id FROM climb WHERE parent_id IS NULL),
    part_no AS (
      SELECT id AS root_id,
             ROW_NUMBER() OVER (PARTITION BY spec_id ORDER BY position) AS n
      FROM paragraphs WHERE parent_id IS NULL AND node_type = 'part'
    )`;
  return {
    ctes,
    join: 'JOIN root_of r ON r.hit_id = hits.id JOIN part_no pn ON pn.root_id = r.root_id',
    where: `WHERE pn.n = $${partParam}`,
  };
}

/**
 * Build the ranked full-text search query. Params order: $1 = query (tsquery),
 * $2 = ILIKE pattern (degenerate fallback), then scope filters, then part, then
 * limit. `WITH RECURSIVE` is always emitted (harmless when no CTE recurses) so the
 * part-filter CTEs can slot in without restructuring.
 */
export function buildParagraphSearch(query: string, options: ParagraphSearchOptions): BuiltQuery {
  const params: unknown[] = [query, likePattern(query)];
  const scope = scopeClauses(options, params);
  const scopeSql = scope.length > 0 ? `AND ${scope.join(' AND ')}` : '';
  const part = partFragments(options, params);
  params.push(options.limit ?? DEFAULT_LIMIT);
  const limitParam = params.length;

  const sql = `WITH RECURSIVE
    q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
    hits AS (
      SELECT p.id, p.parent_id, p.spec_id, p.position, p.text, p.node_type,
             s.id AS spec_ref, s.section, s.title,
             CASE WHEN numnode(q.tsq) > 0
                  THEN ts_rank_cd(p.search_vector, q.tsq) ELSE 0 END AS rank,
             CASE WHEN numnode(q.tsq) > 0
                  THEN ts_headline('english', ${htmlEscapeSql('p.text')}, q.tsq, '${HEADLINE_OPTS}')
                  ELSE ${htmlEscapeSql('left(p.text, 200)')} END AS snippet
      FROM paragraphs p
      CROSS JOIN q
      JOIN specs s ON p.spec_id = s.id
      WHERE ((numnode(q.tsq) > 0 AND p.search_vector @@ q.tsq)
             OR (numnode(q.tsq) = 0 AND p.text ILIKE $2 ESCAPE '\\'))
        ${scopeSql}
    )${part.ctes}
    SELECT hits.id AS "paragraphId", hits.text, hits.node_type AS "nodeType",
           hits.spec_ref AS "specId",
           COALESCE(hits.section, '') AS "specSection",
           COALESCE(hits.title, '') AS "specTitle",
           hits.snippet AS "snippet", hits.rank AS "rank"
    FROM hits
    ${part.join}
    ${part.where}
    ORDER BY hits.rank DESC, hits.section, hits.position
    LIMIT $${limitParam}`;

  return { sql, params };
}
