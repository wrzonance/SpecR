import type { Pool } from 'pg';
import { pool } from '../index.js';
import { DatabaseError } from '../errors.js';
import type { SpecTree } from '../../ast/index.js';
import { validateTree } from './revision-snapshot.js';

interface Queryable {
  query: Pool['query'];
}

/** Per-source column metadata + the lineage/scope guards. A frozen package or
 *  issued-revision id is not a `specs` row, so it never returns → the caller
 *  raises SpecNotFoundError (404). This is how the package/revision non-goal is
 *  enforced with no special-casing. */
export interface ComparisonColumnMeta {
  readonly specId: string;
  readonly section: string;
  readonly title: string | null;
  readonly projectId: string | null;
  readonly libraryId: string | null;
  readonly parentSpecId: string | null;
}

/** Flat paragraph row exposing `origin_paragraph_id` (the alignment key source).
 *  Structurally matches the aligner's `ComparisonParagraph`; the module boundary
 *  keeps the pure aligner independent of DB types. */
export interface ComparisonParagraphRow {
  readonly specId: string;
  readonly id: string;
  readonly originParagraphId: string | null;
  readonly text: string;
  readonly position: number;
  readonly parentId: string | null;
  readonly nodeType: string;
}

interface ColumnMetaRow {
  readonly specId: string;
  readonly section: string;
  readonly title: string | null;
  readonly projectId: string | null;
  readonly libraryId: string | null;
  readonly parentSpecId: string | null;
}

/** Fetch column metadata for the given spec ids. The caller compares the returned
 *  count against the distinct requested ids to detect not-found sources. Ordered
 *  by id so the row order is deterministic; callers that need request/column order
 *  re-index by specId. */
export async function getComparisonColumns(
  specIds: readonly string[],
  db: Queryable = pool
): Promise<readonly ComparisonColumnMeta[]> {
  try {
    const result = await db.query<ColumnMetaRow>(
      `SELECT id AS "specId", section, title,
              project_id AS "projectId", library_id AS "libraryId",
              parent_spec_id AS "parentSpecId"
       FROM specs
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [specIds]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getComparisonColumns failed', { cause: err });
  }
}

/** Flat paragraph loader keyed on `origin_paragraph_id`. Owner-removed subtrees
 *  (vanish=true, non-`note`, ∪ descendants) are excluded so they surface as
 *  `absent` — parity with merge/render. Empty-text paragraphs are DELIBERATELY
 *  retained (unlike buildTree): they are real rows with valid origin links and
 *  UUIDs, and dropping them would be an untraceable hole in the matrix (ADR-047).
 *  Deterministic order: (spec_id, position, id). */
export async function getComparisonParagraphs(
  specIds: readonly string[],
  db: Queryable = pool
): Promise<readonly ComparisonParagraphRow[]> {
  try {
    const result = await db.query<ComparisonParagraphRow>(
      `WITH RECURSIVE removed AS (
         SELECT id FROM paragraphs
          WHERE spec_id = ANY($1::uuid[]) AND vanish = true AND node_type <> 'note'
         UNION ALL
         SELECT c.id FROM paragraphs c JOIN removed r ON c.parent_id = r.id
       )
       SELECT id, spec_id AS "specId", parent_id AS "parentId", node_type AS "nodeType",
              text, position, origin_paragraph_id AS "originParagraphId"
       FROM paragraphs
       WHERE spec_id = ANY($1::uuid[]) AND id NOT IN (SELECT id FROM removed)
       ORDER BY spec_id, position, id`,
      [specIds]
    );
    return result.rows;
  } catch (err) {
    throw new DatabaseError('getComparisonParagraphs failed', { cause: err });
  }
}

/** A frozen `package_revision_specs.tree` snapshot plus the revision's raw
 *  `label` (#392, ADR-078) — the frozen-side counterpart of a live comparison
 *  column. `revisionLabel` is deliberately the raw label, not a
 *  nomenclature-resolved `displayName`: keeps this loader independent of the
 *  nomenclature-profile machinery. */
export interface FrozenComparisonSource {
  readonly tree: SpecTree;
  readonly revisionLabel: string;
}

interface FrozenSourceRow {
  readonly tree: unknown;
  readonly revisionLabel: string;
}

/** One dedicated JOIN rather than a `getPackageRevision` reuse (ADR-078 D3):
 *  that loader fetches every member spec's tree plus a nomenclature-profile
 *  lookup this call site never needs — O(package-size) overfetch for a
 *  single-spec read. Returns null both when `revisionId` doesn't exist and
 *  when it exists but `specId` isn't one of its frozen members; report.ts
 *  raises one `SpecNotFoundError` naming both ids, so the two null causes
 *  don't need to be told apart here. */
export async function getFrozenComparisonSource(
  revisionId: string,
  specId: string,
  db: Queryable = pool
): Promise<FrozenComparisonSource | null> {
  try {
    const result = await db.query<FrozenSourceRow>(
      `SELECT prs.tree, pr.label AS "revisionLabel"
       FROM package_revision_specs prs
       JOIN package_revisions pr ON pr.id = prs.revision_id
       WHERE prs.revision_id = $1 AND prs.spec_id = $2`,
      [revisionId, specId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { tree: validateTree(row.tree, specId), revisionLabel: row.revisionLabel };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('getFrozenComparisonSource failed', { cause: err });
  }
}
