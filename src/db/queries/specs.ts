import { pool, DatabaseError } from '../index.js';
import type { CsiNode, CsiTree, NodeType } from '../../ast/index.js';
import type { Pool } from 'pg';

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

export async function createSpec(input: CreateSpecInput, db: Queryable = pool): Promise<string> {
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO specs (section, title, source) VALUES ($1, $2, $3) RETURNING id`,
      [input.section, input.title, input.source]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('createSpec: no row returned');
    return row.id;
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError('failed to create spec', { cause: err });
  }
}

export async function findSpecById(id: string): Promise<CsiTree | null> {
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

interface ParaRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly node_type: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
}

export interface SpecReference {
  readonly referenceText: string;
  readonly targetSection: string | null;
  readonly targetSpecId: string | null;
  readonly isResolved: boolean;
  readonly isBroken: boolean;
}

export interface SpecTreeResult {
  readonly tree: CsiTree;
  readonly references: readonly SpecReference[];
}

function buildNodeTree(rows: readonly ParaRow[]): readonly CsiNode[] {
  const childrenByParent = new Map<string | null, ParaRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.parent_id, [...(childrenByParent.get(row.parent_id) ?? []), row]);
  }

  function buildNode(row: ParaRow): CsiNode {
    const children = (childrenByParent.get(row.id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map(buildNode);
    return {
      id: row.id,
      type: row.node_type as NodeType,
      text: row.text,
      children,
      meta: row.vanish ? { vanish: true } : {},
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

    const paraResult = await pool.query<ParaRow>(
      `SELECT id, parent_id, node_type, text, position, vanish
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

    const tree: CsiTree = {
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
