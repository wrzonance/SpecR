import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { RevisionNomenclatureTypesSchema } from '../../ast/index.js';
import type { RevisionNomenclatureTypes } from '../../ast/index.js';

export const BUILT_IN_REVISION_NOMENCLATURE_NAME = 'SpecR Default Revision Nomenclature';

export interface RevisionNomenclatureProfile {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  readonly types: RevisionNomenclatureTypes;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface Queryable {
  query: Pool['query'];
}

interface ProfileRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly name: string;
  readonly types: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = 'id, project_id, name, types, created_at, updated_at';

function mapRow(row: ProfileRow): RevisionNomenclatureProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    types: RevisionNomenclatureTypesSchema.parse(row.types),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateTypes(types: RevisionNomenclatureTypes): RevisionNomenclatureTypes {
  return RevisionNomenclatureTypesSchema.parse(types);
}

export async function listRevisionNomenclatureProfiles(
  db: Queryable = pool
): Promise<readonly RevisionNomenclatureProfile[]> {
  try {
    const result = await db.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM revision_nomenclature_profiles
       ORDER BY project_id NULLS FIRST, name, id`
    );
    return result.rows.map(mapRow);
  } catch (err) {
    throw new DatabaseError('listRevisionNomenclatureProfiles: query failed', { cause: err });
  }
}

export async function findRevisionNomenclatureProfileById(
  id: string,
  db: Queryable = pool
): Promise<RevisionNomenclatureProfile | null> {
  try {
    const result = await db.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM revision_nomenclature_profiles WHERE id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new DatabaseError(`findRevisionNomenclatureProfileById: query failed for ${id}`, {
      cause: err,
    });
  }
}

export async function getBuiltInRevisionNomenclature(
  db: Queryable = pool
): Promise<RevisionNomenclatureProfile | null> {
  try {
    const result = await db.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM revision_nomenclature_profiles
       WHERE project_id IS NULL
       ORDER BY created_at
       LIMIT 1`
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  } catch (err) {
    throw new DatabaseError('getBuiltInRevisionNomenclature: query failed', { cause: err });
  }
}

export async function getRevisionNomenclatureForProject(
  projectId: string,
  db: Queryable = pool
): Promise<RevisionNomenclatureProfile | null> {
  try {
    const result = await db.query<ProfileRow>(
      `SELECT ${COLUMNS} FROM revision_nomenclature_profiles
       WHERE project_id = $1
       ORDER BY created_at
       LIMIT 1`,
      [projectId]
    );
    const row = result.rows[0];
    if (row) return mapRow(row);
    return getBuiltInRevisionNomenclature(db);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`getRevisionNomenclatureForProject: query failed for ${projectId}`, {
      cause: err,
    });
  }
}

export async function upsertProjectRevisionNomenclature(
  projectId: string,
  name: string,
  types: RevisionNomenclatureTypes,
  db: Queryable = pool
): Promise<RevisionNomenclatureProfile> {
  const validated = validateTypes(types);
  try {
    const result = await db.query<ProfileRow>(
      `INSERT INTO revision_nomenclature_profiles (project_id, name, types)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id) WHERE project_id IS NOT NULL
       DO UPDATE SET name = EXCLUDED.name, types = EXCLUDED.types, updated_at = now()
       RETURNING ${COLUMNS}`,
      [projectId, name, JSON.stringify(validated)]
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('upsertProjectRevisionNomenclature: no row returned');
    return mapRow(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`upsertProjectRevisionNomenclature: failed for project ${projectId}`, {
      cause: err,
    });
  }
}

export async function deleteProjectRevisionNomenclature(
  projectId: string,
  db: Queryable = pool
): Promise<boolean> {
  try {
    const result = await db.query(
      `DELETE FROM revision_nomenclature_profiles WHERE project_id = $1`,
      [projectId]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    throw new DatabaseError(`deleteProjectRevisionNomenclature: failed for ${projectId}`, {
      cause: err,
    });
  }
}
