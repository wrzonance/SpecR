import { pool, DatabaseError } from '../index.js';
import type { CsiTree } from '../../ast/index.js';

interface SpecRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
  readonly source: string | null;
}

interface UpdateRow {
  readonly id: string;
  readonly section: string | null;
  readonly title: string | null;
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

export async function findSpecById(id: string): Promise<CsiTree | null> {
  try {
    const result = await pool.query<SpecRow>(
      'SELECT id, section, title, source FROM specs WHERE id = $1',
      [id]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { id: row.id, section: row.section ?? '', title: row.title ?? '', parts: [] };
  } catch (err) {
    throw new DatabaseError('failed to find spec by id', { cause: err });
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
