import { pool, DatabaseError } from '../index.js';
import type { SignalConflict, SpecNode, SpecTree, NodeType, SecRef } from '../../ast/index.js';
import type { Pool } from 'pg';
import { insertTree } from './paragraphs.js';
import { insertRefs } from './refs.js';
import { resolveDefaultLibraryId } from './libraries.js';

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

export interface SpecListEntry {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
}

interface SpecListRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
  readonly node_count: string;
}

export async function listSpecs(): Promise<readonly SpecListEntry[]> {
  try {
    const result = await pool.query<SpecListRow>(
      `SELECT s.id, s.section, s.title, COUNT(p.id) AS node_count
       FROM specs s
       LEFT JOIN paragraphs p ON p.spec_id = s.id
       GROUP BY s.id, s.section, s.title
       ORDER BY s.section`
    );
    return result.rows.map((row) => ({
      specId: row.id,
      section: row.section ?? '',
      title: row.title ?? '',
      nodeCount: Number(row.node_count),
    }));
  } catch (err) {
    throw new DatabaseError('failed to list specs', { cause: err });
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
  // Stable identity of the spec_references row — lets clients delete one
  // specific reference, and lets the editor map a citation back to the
  // paragraph that contains it (source_paragraph_id) for removal detection.
  readonly id: string;
  readonly sourceParagraphId: string;
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

/** Paragraph row shape consumed by buildNodeTree (db-module internal). */
export interface ParagraphTreeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly node_type: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
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
    return {
      id: row.id,
      type: row.node_type as NodeType,
      text: row.text,
      children,
      meta: {
        ...(row.vanish ? { vanish: true } : {}),
        ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
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
      `SELECT id, parent_id, node_type, text, position, vanish, conflicts
       FROM paragraphs WHERE spec_id = $1`,
      [id]
    );

    const refResult = await pool.query<{
      id: string;
      source_paragraph_id: string;
      reference_text: string;
      target_spec_section: string | null;
      target_spec_id: string | null;
      is_broken: boolean;
    }>(
      `SELECT id, source_paragraph_id, reference_text, target_spec_section, target_spec_id, is_broken
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
      id: row.id,
      sourceParagraphId: row.source_paragraph_id,
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

// Hard-deletes a spec. Cascades (per schema) to its paragraphs, their
// spec_references and paragraph_versions, and any spec_references whose
// SOURCE is this spec. References from OTHER specs that pointed here have
// target_spec_id set NULL (ON DELETE SET NULL) — their is_broken flag is the
// caller's concern (removeSpecFromProject sets it before this runs).
// Throws a DatabaseError wrapping pg 23503 if the spec is still a member of a
// project (project_specs.spec_id is ON DELETE RESTRICT). Returns false when no
// spec matched the id.
export async function deleteSpec(id: string): Promise<boolean> {
  try {
    const result = await pool.query<{ id: string }>(
      `DELETE FROM specs WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows.length > 0;
  } catch (err) {
    throw new DatabaseError('failed to delete spec', { cause: err });
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
