import { pool, DatabaseError } from '../index.js';
import type { CsiTree } from '../../ast/index.js';
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
