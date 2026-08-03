import { DatabaseError } from '../index.js';
import type { Pool } from 'pg';
import type { SecRef } from '../../ast/types.js';
import { logger } from '../../lib/logger.js';
import { insertRowsInChunks, formatIdsPreview } from './batch-insert.js';
import type { ColumnSpec, ChunkFailureContext } from './batch-insert.js';

interface Queryable {
  query: Pool['query'];
}

/** Column order for a batched `INSERT INTO spec_references`, matching
 *  {@link ResolvedRefRow}'s field order exactly — {@link refRowToParams} must
 *  emit params in this same order. No casts: every column is a plain
 *  text/boolean value. */
const REF_COLUMNS: readonly ColumnSpec[] = [
  { name: 'source_spec_id' },
  { name: 'source_paragraph_id' },
  { name: 'target_type' },
  { name: 'target_spec_section' },
  { name: 'target_spec_id' },
  { name: 'standard_code' },
  { name: 'reference_text' },
];

/** One `spec_references` row after target-spec resolution: every field a
 *  {@link SecRef} needs plus the spec it belongs to, ready to bind in
 *  {@link REF_COLUMNS} order. */
interface ResolvedRefRow {
  readonly sourceSpecId: string;
  readonly sourceParagraphId: string;
  readonly targetType: string;
  readonly targetSpecSection: string | null;
  readonly targetSpecId: string | null;
  readonly standardCode: string | null;
  readonly referenceText: string;
}

/** One row's bind params, in {@link REF_COLUMNS} order. Pure — no I/O. */
function refRowToParams(row: ResolvedRefRow): readonly unknown[] {
  return [
    row.sourceSpecId,
    row.sourceParagraphId,
    row.targetType,
    row.targetSpecSection,
    row.targetSpecId,
    row.standardCode,
    row.referenceText,
  ];
}

/** Unique `targetSpecSection` values among `section`-typed refs, in first-seen
 *  order — the sections {@link fetchSectionSpecIds} needs to resolve in a
 *  single query instead of insertRefs's former one-SELECT-per-ref loop. */
function distinctSections(refs: readonly SecRef[]): readonly string[] {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (ref.targetType === 'section') {
      seen.add(ref.targetSpecSection);
    }
  }
  return [...seen];
}

/** Resolves every section in `sections` to its spec id via one batched
 *  `= ANY($1)` SELECT — a no-op (zero queries) when `sections` is empty, so a
 *  standard-only ref batch never touches `specs` at all.
 *
 *  `specs.section` is not globally unique (uniqueness is per
 *  `(section, source, library_id)` and per `(section, project_id)` — migration
 *  016), so a section can legitimately match several specs. Which one wins is
 *  arbitrary in both the old and new code, but **first-row-wins is what the
 *  pre-batch `SELECT … LIMIT 1` actually did**, so this keeps the first row and
 *  ignores later duplicates. A last-wins map would silently repoint
 *  `target_spec_id` at a different spec than the per-ref code chose — a
 *  behavior change this pure-performance batching must not make. Neither form
 *  carries an `ORDER BY`; making duplicate resolution genuinely deterministic
 *  is a separate concern, out of this change's scope. */
async function fetchSectionSpecIds(
  pool: Queryable,
  sections: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  if (sections.length === 0) return new Map();
  try {
    const result = await pool.query<{ id: string; section: string }>(
      'SELECT id, section FROM specs WHERE section = ANY($1::text[])',
      [sections]
    );
    const bySection = new Map<string, string>();
    for (const row of result.rows) {
      if (!bySection.has(row.section)) {
        bySection.set(row.section, row.id);
      }
    }
    return bySection;
  } catch (err) {
    throw new DatabaseError(
      `insertRefs: failed to resolve target spec ids for ${sections.length} section(s) ` +
        `(${formatIdsPreview(sections)})`,
      { cause: err }
    );
  }
}

/** Pure, total: pairs each ref with its resolved target spec id (via the
 *  pre-fetched `sectionToSpecId` map, `section` refs only — `standard` refs
 *  always carry a null target) into one {@link ResolvedRefRow} per ref, in
 *  input order. */
function resolveRefRows(
  refs: readonly SecRef[],
  specId: string,
  sectionToSpecId: ReadonlyMap<string, string>
): readonly ResolvedRefRow[] {
  return refs.map((ref) => ({
    sourceSpecId: specId,
    sourceParagraphId: ref.sourceNodeId,
    targetType: ref.targetType,
    targetSpecSection: ref.targetType === 'section' ? ref.targetSpecSection : null,
    targetSpecId:
      ref.targetType === 'section' ? (sectionToSpecId.get(ref.targetSpecSection) ?? null) : null,
    standardCode: ref.targetType === 'standard' ? ref.standardCode : null,
    referenceText: ref.referenceText,
  }));
}

/** Builds the batch-error message for a failed reference chunk (#618): names
 *  which chunk failed (1-based, out of how many), how many refs it carried,
 *  and a bounded preview of the failing rows' source paragraph ids — a
 *  per-chunk identity rather than the single failing ref's id, since one
 *  INSERT now carries many refs. */
function buildInsertRefsErrorMessage(ctx: ChunkFailureContext): string {
  return (
    `insertRefs: failed to insert reference batch ${ctx.chunkIndex + 1}/${ctx.totalChunks} ` +
    `(${ctx.rowCount} refs, source paragraphs: ${formatIdsPreview(ctx.ids)})`
  );
}

interface OutboundReferenceRow {
  readonly source_spec_id: string;
  readonly source_paragraph_id: string;
  readonly reference_text: string;
  readonly target_spec_section: string | null;
  readonly target_spec_id: string | null;
  readonly is_broken: boolean;
}

interface InboundReferenceRow {
  readonly source_spec_id: string;
  readonly source_section: string;
  readonly source_title: string;
  readonly source_paragraph_id: string;
  readonly reference_text: string;
  readonly target_spec_id: string | null;
  readonly is_broken: boolean;
}

export interface OutboundReference {
  readonly sourceSpecId: string;
  /** Paragraph the reference sits in — the paragraph-level locator (issue #373).
   *  Lets a client index references per paragraph (web_ui_demo removed-citation flow). */
  readonly sourceParagraphId: string;
  readonly referenceText: string;
  readonly targetSection: string | null;
  readonly targetSpecId: string | null;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

export interface InboundReference {
  readonly sourceSpecId: string;
  readonly sourceSection: string;
  readonly sourceTitle: string;
  readonly sourceParagraphId: string;
  readonly referenceText: string;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

function mapOutbound(row: OutboundReferenceRow): OutboundReference {
  return {
    sourceSpecId: row.source_spec_id,
    sourceParagraphId: row.source_paragraph_id,
    referenceText: row.reference_text,
    targetSection: row.target_spec_section,
    targetSpecId: row.target_spec_id,
    isResolved: row.target_spec_id !== null,
    isBroken: row.is_broken,
  };
}

function mapInbound(row: InboundReferenceRow): InboundReference {
  return {
    sourceSpecId: row.source_spec_id,
    sourceSection: row.source_section,
    sourceTitle: row.source_title,
    sourceParagraphId: row.source_paragraph_id,
    referenceText: row.reference_text,
    isResolved: row.target_spec_id !== null,
    isBroken: row.is_broken,
  };
}

export async function insertRefs(
  refs: readonly SecRef[],
  specId: string,
  pool: Queryable
): Promise<void> {
  if (refs.length === 0) {
    return;
  }

  const sections = distinctSections(refs);
  const sectionToSpecId = await fetchSectionSpecIds(pool, sections);
  const rows = resolveRefRows(refs, specId, sectionToSpecId);

  await insertRowsInChunks({
    db: pool,
    table: 'spec_references',
    columns: REF_COLUMNS,
    rows,
    toParams: refRowToParams,
    idOf: (row) => row.sourceParagraphId,
    buildErrorMessage: buildInsertRefsErrorMessage,
  });

  logger.info({ specId, count: refs.length }, 'insertRefs: references inserted');
}

export async function getInboundReferences(
  section: string,
  projectId: string,
  pool: Queryable
): Promise<readonly InboundReference[]> {
  try {
    const result = await pool.query<InboundReferenceRow>(
      `SELECT sr.source_spec_id, s.section AS source_section, s.title AS source_title,
              sr.source_paragraph_id, sr.reference_text, sr.target_spec_id, sr.is_broken
       FROM spec_references sr
       JOIN specs s ON sr.source_spec_id = s.id
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id
       WHERE ps.project_id = $2 AND sr.target_spec_section = $1
       ORDER BY s.section, sr.source_paragraph_id`,
      [section, projectId]
    );
    return result.rows.map(mapInbound);
  } catch (err) {
    throw new DatabaseError(
      `getInboundReferences: query failed for project ${projectId}, section ${section}`,
      { cause: err }
    );
  }
}

export async function getOutboundReferences(
  specId: string,
  projectId: string,
  pool: Queryable
): Promise<readonly OutboundReference[]> {
  try {
    const result = await pool.query<OutboundReferenceRow>(
      `SELECT sr.source_spec_id, sr.source_paragraph_id, sr.reference_text,
              sr.target_spec_section, sr.target_spec_id, sr.is_broken
       FROM spec_references sr
       JOIN project_specs ps ON ps.spec_id = sr.source_spec_id
       WHERE sr.source_spec_id = $1 AND ps.project_id = $2
       ORDER BY sr.source_paragraph_id`,
      [specId, projectId]
    );
    return result.rows.map(mapOutbound);
  } catch (err) {
    throw new DatabaseError(
      `getOutboundReferences: query failed for project ${projectId}, spec ${specId}`,
      { cause: err }
    );
  }
}

export async function findProjectSpecIdsBySection(
  section: string,
  projectId: string,
  pool: Queryable
): Promise<readonly string[]> {
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT s.id
       FROM specs s
       JOIN project_specs ps ON ps.spec_id = s.id
       WHERE ps.project_id = $2 AND s.section = $1
       ORDER BY s.id`,
      [section, projectId]
    );
    return result.rows.map((row) => row.id);
  } catch (err) {
    throw new DatabaseError(
      `findProjectSpecIdsBySection: query failed for project ${projectId}, section ${section}`,
      { cause: err }
    );
  }
}

export async function isSpecInProject(
  specId: string,
  projectId: string,
  pool: Queryable
): Promise<boolean> {
  try {
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM project_specs WHERE project_id = $1 AND spec_id = $2
       ) AS exists`,
      [projectId, specId]
    );
    return result.rows[0]?.exists ?? false;
  } catch (err) {
    throw new DatabaseError(
      `isSpecInProject: query failed for project ${projectId}, spec ${specId}`,
      { cause: err }
    );
  }
}
