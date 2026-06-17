import { pool, DatabaseError } from '../index.js';
import type {
  SignalConflict,
  SourceFacts,
  SpecNode,
  SpecNodeEditability,
  SpecTree,
  NodeType,
  SecRef,
} from '../../ast/index.js';
import type { Pool } from 'pg';
import { insertTree } from './paragraphs.js';
import { insertRefs } from './refs.js';
import { resolveDefaultLibraryId } from './libraries.js';
import { reconcileLibraryDivisionGeneralSpec } from './division-general.js';
import { ClassificationSchema, OverrideSchema } from './editability.js';

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
  readonly classification: unknown;
  readonly editability_override: unknown;
}

function hasSourceFacts(sourceFacts: SourceFacts): boolean {
  return Object.keys(sourceFacts).length > 0;
}

/**
 * Derive the effective `meta.editability` from the two raw JSONB columns,
 * validating both via the closed schemas (a corrupt row is a loud DatabaseError,
 * never a silent drop). Returns undefined when the paragraph is unclassified, so
 * the field is omitted entirely (mirrors the conflicts/sourceFacts omit-when-empty
 * pattern). Effective `value` = override ?? machine; the machine's verdict stays
 * readable so a UI can show what was overridden (#134 §5).
 */
function deriveEditability(
  classification: unknown,
  override: unknown
): SpecNodeEditability | undefined {
  if (classification === null || classification === undefined) return undefined;
  const machine = ClassificationSchema.parse(classification);
  const overrideValue =
    override === null || override === undefined
      ? undefined
      : OverrideSchema.parse(override).editability;
  return {
    value: overrideValue ?? machine.editability,
    confidence: machine.confidence,
    evidence: machine.evidence,
    ...(overrideValue !== undefined ? { override: overrideValue } : {}),
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
    return {
      id: row.id,
      type: row.node_type as NodeType,
      text: row.text,
      children,
      meta: {
        ...(row.vanish ? { vanish: true } : {}),
        ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
        ...(hasSourceFacts(row.source_facts) ? { sourceFacts: row.source_facts } : {}),
        ...(editability ? { editability } : {}),
      },
    };
  }

  return (childrenByParent.get(null) ?? []).sort((a, b) => a.position - b.position).map(buildNode);
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
              classification, editability_override
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

    const tree: SpecTree = {
      id: specRow.id,
      section: specRow.section ?? '',
      title: specRow.title ?? '',
      parts: buildNodeTree(paraResult.rows),
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

export async function persistParsedSpec(result: {
  readonly tree: SpecTree;
  readonly refs: readonly SecRef[];
  readonly originMeta?: OriginMeta;
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // eslint-disable-next-line sonarjs/todo-tag
    // TODO: source should be a top-level SpecTree field — parts[0].meta.source is a stopgap
    const source = result.tree.parts[0]?.meta.source ?? 'unknown';
    const libraryId = await resolveDefaultLibraryId(source, client);
    const res = await client.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id, origin_meta)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (section, source, library_id) WHERE library_id IS NOT NULL DO UPDATE
         SET title = EXCLUDED.title,
             updated_at = now(),
             content_version = specs.content_version + 1,
             origin_meta = COALESCE(EXCLUDED.origin_meta, specs.origin_meta)
       RETURNING id`,
      [
        result.tree.section,
        result.tree.title,
        source,
        libraryId,
        result.originMeta ? JSON.stringify(result.originMeta) : null,
      ]
    );
    const specId = res.rows[0]?.id;
    if (!specId) throw new DatabaseError('upsert spec returned no id');
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
