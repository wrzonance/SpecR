import type { Pool, PoolClient } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import { SpecNotFoundError } from './edit-gate.js';
import { ProjectNotFoundError } from './derive.js';
import { SourceFactsSchema } from '../../ast/index.js';

interface Queryable {
  query: Pool['query'];
}

// Scope of an open-comments report: a single spec, or every project-spec.
export type OpenCommentsScope =
  | { readonly kind: 'spec'; readonly specId: string }
  | { readonly kind: 'project'; readonly projectId: string };

// One unresolved comment occurrence. A comment spanning N paragraphs (#128) is
// stored as N facts, so it surfaces once per covered paragraph — paragraphId
// distinguishes the occurrences.
export interface OpenComment {
  readonly specId: string;
  readonly specSection: string;
  readonly paragraphId: string;
  readonly author: string;
  readonly text: string;
  readonly anchor: readonly [number, number];
}

export interface OpenCommentsSummary {
  readonly open: number;
  /** Total comment occurrences in scope (open + closed). */
  readonly total: number;
}

export interface OpenCommentsReport {
  readonly scope: OpenCommentsScope;
  readonly openComments: readonly OpenComment[];
  readonly summary: OpenCommentsSummary;
}

interface ParagraphFactsRow {
  readonly paragraphId: string;
  readonly specId: string;
  readonly specSection: string;
  readonly sourceFacts: unknown;
}

const SPEC_SQL = `SELECT p.id AS "paragraphId", s.id AS "specId", s.section AS "specSection",
                         p.source_facts AS "sourceFacts"
                  FROM paragraphs p JOIN specs s ON s.id = p.spec_id
                  WHERE p.spec_id = $1
                  ORDER BY s.section, p.position`;

const PROJECT_SQL = `SELECT p.id AS "paragraphId", s.id AS "specId", s.section AS "specSection",
                            p.source_facts AS "sourceFacts"
                     FROM project_specs ps
                       JOIN specs s ON s.id = ps.spec_id
                       JOIN paragraphs p ON p.spec_id = s.id
                     WHERE ps.project_id = $1
                     ORDER BY s.section, p.position`;

async function assertScope(scope: OpenCommentsScope, client: Queryable): Promise<void> {
  if (scope.kind === 'spec') {
    const r = await client.query(`SELECT 1 FROM specs WHERE id = $1`, [scope.specId]);
    if ((r.rowCount ?? 0) === 0) throw new SpecNotFoundError(`spec ${scope.specId} not found`);
    return;
  }
  const r = await client.query(`SELECT 1 FROM projects WHERE id = $1`, [scope.projectId]);
  if ((r.rowCount ?? 0) === 0)
    throw new ProjectNotFoundError(`project ${scope.projectId} not found`);
}

async function readParagraphFacts(
  scope: OpenCommentsScope,
  client: Queryable
): Promise<readonly ParagraphFactsRow[]> {
  const sql = scope.kind === 'spec' ? SPEC_SQL : PROJECT_SQL;
  const id = scope.kind === 'spec' ? scope.specId : scope.projectId;
  const r = await client.query<ParagraphFactsRow>(sql, [id]);
  return r.rows;
}

// Split one paragraph's comment facts into open occurrences + a total count.
// source_facts is validated through SourceFactsSchema so a row written before the
// closed field existed still yields closed === false (the schema default).
function splitComments(row: ParagraphFactsRow): {
  readonly open: readonly OpenComment[];
  readonly total: number;
} {
  const facts = SourceFactsSchema.parse(row.sourceFacts ?? {});
  const comments = facts.comments ?? [];
  const open = comments
    .filter((c) => !c.closed)
    .map((c) => ({
      specId: row.specId,
      specSection: row.specSection,
      paragraphId: row.paragraphId,
      author: c.author,
      text: c.text,
      anchor: c.anchor,
    }));
  return { open, total: comments.length };
}

function buildReport(
  scope: OpenCommentsScope,
  rows: readonly ParagraphFactsRow[]
): OpenCommentsReport {
  const openComments: OpenComment[] = [];
  let total = 0;
  for (const row of rows) {
    const { open, total: rowTotal } = splitComments(row);
    openComments.push(...open);
    total += rowTotal;
  }
  return { scope, openComments, summary: { open: openComments.length, total } };
}

/**
 * Report the unresolved (open) Word comments in a spec or project — the direct
 * answer to #256 C1 "have all the inserted comments been closed?". A comment is
 * closed when struck through or "Closed"-suffixed (see comment-closure.ts); this
 * lists the rest.
 */
export async function getOpenCommentsReport(
  scope: OpenCommentsScope,
  db: Pool = pool
): Promise<OpenCommentsReport> {
  let client: PoolClient | null = null;
  try {
    client = await db.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await assertScope(scope, client);
    const rows = await readParagraphFacts(scope, client);
    await client.query('COMMIT');
    return buildReport(scope, rows);
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => undefined);
    if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) throw err;
    throw new DatabaseError('getOpenCommentsReport failed', { cause: err });
  } finally {
    if (client) client.release();
  }
}
