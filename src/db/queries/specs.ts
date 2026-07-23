import { pool, DatabaseError } from '../index.js';
import { parseSourceFacts } from '../../ast/index.js';
import type {
  ParagraphAssociation,
  SignalConflict,
  SourceFacts,
  SpecNode,
  SpecNodeMeta,
  SpecTree,
  SecRef,
} from '../../ast/index.js';
import { deriveArticleRole } from '../../ast/index.js';
import type { Pool } from 'pg';
import { insertTree } from './paragraphs.js';
import { insertRefs } from './refs.js';
import { resolveDefaultLibraryId } from './libraries.js';
import { reconcileLibraryDivisionGeneralSpec } from './division-general.js';
import { deriveEditability } from './editability.js';
import { listAssociationsForSpec } from './associations.js';
import { deriveInference } from './inference-meta.js';
import { parseNodeType } from './node-type.js';
import { parseObjectMeta } from './object-meta.js';

interface SpecRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
}

interface UpdateRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
}

interface Queryable {
  query: Pool['query'];
}

export interface CreateSpecInput {
  readonly section: string;
  readonly title: string;
  readonly source: string;
  /** Owning library. Omitted → resolved from source (ufgs → UFGS Reference, else Default Company Master). */
  readonly libraryId?: string;
}

export interface SpecSummary {
  readonly specId: string;
  readonly title: string;
  readonly section: string;
}

export interface UpdateSpecInput {
  readonly title?: string;
  readonly section?: string;
}

/** Ingest provenance recorded on specs.origin_meta (ADR-015 D2). */
export interface OriginMeta {
  readonly filename: string;
  readonly sha256: string;
  readonly loader: string;
}

export async function createSpec(input: CreateSpecInput, db: Queryable = pool): Promise<string> {
  try {
    const libraryId = input.libraryId ?? (await resolveDefaultLibraryId(input.source, db));
    const result = await db.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.section, input.title, input.source, libraryId]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createSpec: no row returned');
    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create spec', { cause: err });
  }
}

export async function findSpecById(id: string): Promise<SpecTree | null> {
  try {
    const result = await pool.query<SpecRow>('SELECT id, section, title FROM specs WHERE id = $1', [
      id,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, section: row.section ?? '', title: row.title ?? '', parts: [] };
  } catch (err) {
    throw new DatabaseError('failed to find spec by id', { cause: err });
  }
}

export interface SpecReference {
  readonly referenceText: string;
  readonly targetSection: string | null;
  readonly targetSpecId: string | null;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

export interface SpecTreeResult {
  readonly tree: SpecTree;
  readonly references: readonly SpecReference[];
}

/** Paragraph row shape consumed by buildNodeTree (db-module internal).
 *  `classification` / `editability_override` are raw JSONB (validated, not
 *  trusted, in buildNodeTree); NULL until the paragraph is classified. */
export interface ParagraphTreeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly node_type: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly source_facts: SourceFacts;
  readonly signal_provenance: unknown;
  readonly classification: unknown;
  readonly editability_override: unknown;
  readonly object_data: unknown;
  readonly page_break_before: boolean;
}

function hasSourceFacts(sourceFacts: SourceFacts): boolean {
  return Object.keys(sourceFacts).length > 0;
}

/** Assemble a node's `meta` from its row and the values derived from it, each
 *  field omitted when empty (mirrors the omit-when-empty pattern elsewhere).
 *  Extracted from `buildNode` so that function stays under the complexity cap. */
function buildNodeMeta(
  row: ParagraphTreeRow,
  derived: {
    readonly sourceFacts: SourceFacts;
    readonly inference: ReturnType<typeof deriveInference>;
    readonly editability: ReturnType<typeof deriveEditability>;
    readonly articleRole: ReturnType<typeof deriveArticleRole>;
    readonly objectMeta: ReturnType<typeof parseObjectMeta>;
  }
): SpecNodeMeta {
  const { sourceFacts, inference, editability, articleRole, objectMeta } = derived;
  return {
    ...(row.vanish ? { vanish: true } : {}),
    ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
    ...(hasSourceFacts(sourceFacts) ? { sourceFacts } : {}),
    ...(inference ? { inference } : {}),
    ...(editability ? { editability } : {}),
    ...(articleRole !== undefined ? { articleRole } : {}),
    ...(objectMeta ? { object: objectMeta } : {}),
    ...(row.page_break_before ? { pageBreakBefore: true } : {}),
  };
}

/** Assemble flat paragraph rows into a SpecNode forest. Exported for reuse
 *  inside the db module (revisions snapshotting) — not part of the barrel. */
export function buildNodeTree(rows: readonly ParagraphTreeRow[]): readonly SpecNode[] {
  const childrenByParent = new Map<string | null, ParagraphTreeRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.parent_id, [...(childrenByParent.get(row.parent_id) ?? []), row]);
  }

  function buildNode(row: ParagraphTreeRow): SpecNode {
    const children = (childrenByParent.get(row.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map(buildNode);
    const editability = deriveEditability(row.classification, row.editability_override);
    // Normalize through the schema so legacy comment facts gain the backfilled
    // `closed` flag before they reach the API response (#262).
    const sourceFacts = parseSourceFacts(row.source_facts);
    const nodeType = parseNodeType(row.node_type, 'buildNodeTree');
    const articleRole = nodeType === 'article' ? deriveArticleRole(row.text) : undefined;
    const inference = deriveInference(row.signal_provenance, row.conflicts, nodeType);
    const objectMeta = parseObjectMeta(nodeType, row.object_data, 'buildNodeTree');
    return {
      id: row.id,
      type: nodeType,
      text: row.text,
      children,
      meta: buildNodeMeta(row, { sourceFacts, inference, editability, articleRole, objectMeta }),
    };
  }

  return (childrenByParent.get(null) ?? []).sort((a, b) => a.position - b.position).map(buildNode);
}

function attachAssociations(
  nodes: readonly SpecNode[],
  byParagraph: ReadonlyMap<string, readonly ParagraphAssociation[]>
): readonly SpecNode[] {
  return nodes.map((node) => {
    const associations = byParagraph.get(node.id);
    const children = attachAssociations(node.children, byParagraph);
    return {
      ...node,
      children,
      meta: {
        ...node.meta,
        ...(associations !== undefined && associations.length > 0 ? { associations } : {}),
      },
    };
  });
}

export async function getSpecTree(id: string): Promise<SpecTreeResult | null> {
  try {
    const specResult = await pool.query<SpecRow>(
      'SELECT id, section, title FROM specs WHERE id = $1',
      [id]
    );
    const specRow = specResult.rows[0];
    if (!specRow) return null;

    const paraResult = await pool.query<ParagraphTreeRow>(
      `SELECT id, parent_id, node_type, text, position, vanish, conflicts, source_facts,
              signal_provenance, classification, editability_override, object_data,
              page_break_before
       FROM paragraphs WHERE spec_id = $1`,
      [id]
    );

    const refResult = await pool.query<{
      reference_text: string;
      target_spec_section: string | null;
      target_spec_id: string | null;
      is_broken: boolean;
    }>(
      `SELECT reference_text, target_spec_section, target_spec_id, is_broken
       FROM spec_references WHERE source_spec_id = $1`,
      [id]
    );

    const associationMap = await listAssociationsForSpec(id);
    const tree: SpecTree = {
      id: specRow.id,
      section: specRow.section ?? '',
      title: specRow.title ?? '',
      parts: attachAssociations(buildNodeTree(paraResult.rows), associationMap),
    };

    const references: readonly SpecReference[] = refResult.rows.map((row) => ({
      referenceText: row.reference_text,
      targetSection: row.target_spec_section,
      targetSpecId: row.target_spec_id,
      isResolved: row.target_spec_id !== null,
      isBroken: row.is_broken,
    }));

    return { tree, references };
  } catch (err) {
    throw new DatabaseError('getSpecTree failed', { cause: err });
  }
}

export async function updateSpec(id: string, input: UpdateSpecInput): Promise<SpecSummary | null> {
  try {
    const result = await pool.query<UpdateRow>(
      `UPDATE specs
       SET title = COALESCE($1, title),
           section = COALESCE($2, section),
           content_version = content_version + CASE
             WHEN title IS DISTINCT FROM COALESCE($1, title)
               OR section IS DISTINCT FROM COALESCE($2, section)
             THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE id = $3
       RETURNING id, section, title`,
      [input.title ?? null, input.section ?? null, id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { specId: row.id, section: row.section ?? '', title: row.title ?? '' };
  } catch (err) {
    throw new DatabaseError('failed to update spec', { cause: err });
  }
}

/** Outcome of a spec withdraw (ADR-030). `withdrawn` is idempotent — a
 *  re-withdraw returns the ORIGINAL `withdrawnAt`. `project-copy` (→ 409)
 *  steers the caller to the membership endpoint; `not-found` → 404. */
export type WithdrawSpecOutcome =
  | { readonly kind: 'withdrawn'; readonly specId: string; readonly withdrawnAt: string }
  | { readonly kind: 'project-copy' }
  | { readonly kind: 'not-found' };

/** Outcome of a spec restore (ADR-030). `restored` is idempotent — restoring an
 *  already-active master is a 200 no-op. Withdrawal is a library-master concept,
 *  so a project copy returns `project-copy` (→ 409), mirroring withdraw. */
export type RestoreSpecOutcome =
  | { readonly kind: 'restored'; readonly specId: string }
  | { readonly kind: 'project-copy' }
  | { readonly kind: 'not-found' };

/**
 * Soft-withdraw a library master (ADR-030): tombstone it with
 * `withdrawn_at = now()`. The row, its paragraphs, and `parent_spec_id` lineage
 * edges stay intact — only listings/resolution hide it. **Idempotent**:
 * `COALESCE` preserves an existing `withdrawn_at`, so a re-withdraw returns the
 * ORIGINAL timestamp. Withdrawal targets masters only; a project copy
 * (`project_id` set, `library_id` null) returns `project-copy`. One statement: a
 * `target` CTE classifies the row, an `updated` CTE writes only when it is a
 * master, and the final SELECT joins both so `not-found` / `project-copy` /
 * `withdrawn` are distinguishable from a single round trip.
 */
export async function withdrawSpec(id: string): Promise<WithdrawSpecOutcome> {
  try {
    const { rows } = await pool.query<{
      id: string;
      is_master: boolean;
      withdrawn_at: Date | null;
    }>(
      `WITH target AS (
         SELECT id, library_id, withdrawn_at FROM specs WHERE id = $1
       ),
       updated AS (
         UPDATE specs s
         SET withdrawn_at = COALESCE(s.withdrawn_at, now())
         FROM target t
         WHERE s.id = t.id AND t.library_id IS NOT NULL AND s.withdrawn_at IS NULL
         RETURNING s.id, s.withdrawn_at
       )
       SELECT t.id,
              (t.library_id IS NOT NULL) AS is_master,
              COALESCE(u.withdrawn_at, t.withdrawn_at) AS withdrawn_at
       FROM target t
       LEFT JOIN updated u ON u.id = t.id`,
      [id]
    );
    const row = rows[0];
    if (!row) return { kind: 'not-found' };
    if (!row.is_master) return { kind: 'project-copy' };
    if (!row.withdrawn_at) {
      throw new DatabaseError('withdrawSpec: master row missing withdrawn_at after update');
    }
    return { kind: 'withdrawn', specId: row.id, withdrawnAt: row.withdrawn_at.toISOString() };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`withdrawSpec: update failed for ${id}`, { cause: err });
  }
}

/**
 * Restore a withdrawn library master (ADR-030): clear `withdrawn_at`.
 * **Idempotent** — restoring an already-active master is a 200 no-op. Mirrors
 * `withdrawSpec` on ownership: a project copy returns `project-copy` (→ 409),
 * unknown id → `not-found` (→ 404).
 */
export async function restoreSpec(id: string): Promise<RestoreSpecOutcome> {
  try {
    const { rows } = await pool.query<{ id: string; is_master: boolean }>(
      `WITH target AS (
         SELECT id, library_id FROM specs WHERE id = $1
       ),
       updated AS (
         UPDATE specs s
         SET withdrawn_at = NULL
         FROM target t
         WHERE s.id = t.id AND t.library_id IS NOT NULL AND s.withdrawn_at IS NOT NULL
         RETURNING s.id
       )
       SELECT t.id, (t.library_id IS NOT NULL) AS is_master
       FROM target t
       LEFT JOIN updated u ON u.id = t.id`,
      [id]
    );
    const row = rows[0];
    if (!row) return { kind: 'not-found' };
    if (!row.is_master) return { kind: 'project-copy' };
    return { kind: 'restored', specId: row.id };
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`restoreSpec: update failed for ${id}`, { cause: err });
  }
}

/** The spec's persisted source label ('ufgs' | 'arcat' | 'cpi' | 'unknown'),
 *  or null when the spec does not exist. Used by the onboarding report to
 *  distinguish explicit-structure sources from unscored DOCX (ADR-055). */
export async function getSpecSource(id: string): Promise<string | null> {
  try {
    const result = await pool.query<{ source: string }>('SELECT source FROM specs WHERE id = $1', [
      id,
    ]);
    return result.rows[0]?.source ?? null;
  } catch (err) {
    throw new DatabaseError('getSpecSource failed', { cause: err });
  }
}

/** The spec's withdrawal tombstone as ISO-8601, or null when active/unknown.
 *  Surfaced on GET /specs/:id so a withdrawn master's lineage/history still
 *  resolves (ADR-030) — only listings/resolution hide it. */
export async function getSpecWithdrawnAt(id: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ withdrawn_at: Date | null }>(
      `SELECT withdrawn_at FROM specs WHERE id = $1`,
      [id]
    );
    const row = rows[0];
    return row?.withdrawn_at ? row.withdrawn_at.toISOString() : null;
  } catch (err) {
    throw new DatabaseError(`getSpecWithdrawnAt: query failed for ${id}`, { cause: err });
  }
}

/** Upsert the master row for a parsed import. New imports land at
 *  onboarding_status 'review' (O-8/#135 → O-11/#139) awaiting a human's
 *  first-pass review. On re-import (ON CONFLICT) the status is intentionally
 *  NOT reset — a prior finalize stands — but a withdrawn master IS revived
 *  (#415): without withdrawn_at = NULL the fresh parse lands invisibly in the
 *  tombstoned row. */
async function upsertParsedSpecRow(
  tree: SpecTree,
  originMeta: OriginMeta | undefined,
  source: string,
  libraryId: string,
  db: Queryable
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, origin_meta, onboarding_status)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'review')
     ON CONFLICT (section, source, library_id) WHERE library_id IS NOT NULL DO UPDATE
       SET title = EXCLUDED.title,
           updated_at = now(),
           content_version = specs.content_version + 1,
           origin_meta = COALESCE(EXCLUDED.origin_meta, specs.origin_meta),
           withdrawn_at = NULL
     RETURNING id`,
    [tree.section, tree.title, source, libraryId, originMeta ? JSON.stringify(originMeta) : null]
  );
  const specId = res.rows[0]?.id;
  if (!specId) throw new DatabaseError('upsert spec returned no id');
  return specId;
}

export async function persistParsedSpec(result: {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly originMeta?: OriginMeta;
  /** Explicit owning library (O-8 onboarding). Omitted → resolved from source. */
  readonly libraryId?: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // eslint-disable-next-line sonarjs/todo-tag
    // TODO: source should be a top-level SpecTree field — parts[0].meta.source is a stopgap
    const source = result.tree.parts[0]?.meta.source ?? 'unknown';
    const libraryId = result.libraryId ?? (await resolveDefaultLibraryId(source, client));
    const specId = await upsertParsedSpecRow(
      result.tree,
      result.originMeta,
      source,
      libraryId,
      client
    );
    await client.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [specId]);
    await client.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [specId]);
    const treeWithId: SpecTree = { ...result.tree, id: specId };
    await insertTree(treeWithId, specId, client);
    if (result.refs.length > 0) {
      await insertRefs(result.refs, specId, client);
    }
    await reconcileLibraryDivisionGeneralSpec(libraryId, result.tree.section, client);
    await client.query('COMMIT');
    return specId;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw new DatabaseError('failed to persist parsed spec', { cause: err });
  } finally {
    client.release();
  }
}
