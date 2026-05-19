import type { Pool } from 'pg';
import { pool, DatabaseError } from '../index.js';
import { logger } from '../../lib/logger.js';

interface Queryable {
  query: Pool['query'];
}

export type RevitDirection = 'to_spec' | 'to_revit' | 'bidirectional' | 'spec_only';
export type RevitTransformType = 'replace' | 'placeholder' | 'append' | 'prepend';

export interface RevitMapping {
  readonly id: string;
  readonly paragraphId: string;
  readonly revitInstanceId: string;
  readonly revitComponentRole: string | null;
  readonly revitParam: string;
  readonly direction: RevitDirection;
  readonly transformType: RevitTransformType;
  readonly transformConfig: unknown;
  readonly createdAt: Date;
}

export interface RevitMappingInput {
  readonly paragraphId: string;
  readonly revitInstanceId: string;
  readonly revitComponentRole?: string | null;
  readonly revitParam: string;
  readonly direction?: RevitDirection;
  readonly transformType: RevitTransformType;
  readonly transformConfig?: unknown;
}

// pg returns snake_case column names as-is. Use an internal row type that
// mirrors the table verbatim, then map it once at the boundary.
interface RevitMappingRow {
  readonly id: string;
  readonly paragraph_id: string;
  readonly revit_instance_id: string;
  readonly revit_component_role: string | null;
  readonly revit_param: string;
  readonly direction: RevitDirection;
  readonly transform_type: RevitTransformType;
  readonly transform_config: unknown;
  readonly created_at: Date;
}

function rowToMapping(row: RevitMappingRow): RevitMapping {
  return {
    id: row.id,
    paragraphId: row.paragraph_id,
    revitInstanceId: row.revit_instance_id,
    revitComponentRole: row.revit_component_role,
    revitParam: row.revit_param,
    direction: row.direction,
    transformType: row.transform_type,
    transformConfig: row.transform_config,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = `id, paragraph_id, revit_instance_id, revit_component_role,
                        revit_param, direction, transform_type, transform_config, created_at`;

export async function upsertMapping(
  input: RevitMappingInput,
  client: Queryable = pool
): Promise<RevitMapping> {
  // Serialize transform_config explicitly — undefined → SQL NULL.
  const transformConfig =
    input.transformConfig === undefined ? null : JSON.stringify(input.transformConfig);
  try {
    const result = await client.query<RevitMappingRow>(
      `INSERT INTO revit_parameter_mappings
         (paragraph_id, revit_instance_id, revit_component_role,
          revit_param, direction, transform_type, transform_config)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'to_spec'), $6, $7::jsonb)
       ON CONFLICT (paragraph_id, revit_instance_id, revit_component_role, revit_param)
       DO UPDATE SET
         direction        = EXCLUDED.direction,
         transform_type   = EXCLUDED.transform_type,
         transform_config = EXCLUDED.transform_config
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.paragraphId,
        input.revitInstanceId,
        input.revitComponentRole ?? null,
        input.revitParam,
        input.direction ?? null,
        input.transformType,
        transformConfig,
      ]
    );
    const row = result.rows[0];
    if (!row) {
      throw new DatabaseError('upsertMapping: no row returned after INSERT...ON CONFLICT');
    }
    logger.debug(
      { mappingId: row.id, paragraphId: row.paragraph_id, instanceId: row.revit_instance_id },
      'upsertMapping: persisted'
    );
    return rowToMapping(row);
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(
      `upsertMapping: failed for paragraph ${input.paragraphId}, instance ${input.revitInstanceId}, param ${input.revitParam}`,
      { cause: err }
    );
  }
}

export async function deleteMapping(id: string, client: Queryable = pool): Promise<void> {
  try {
    await client.query('DELETE FROM revit_parameter_mappings WHERE id = $1', [id]);
  } catch (err) {
    throw new DatabaseError(`deleteMapping: failed for ${id}`, { cause: err });
  }
}

export async function getMappingsBySpec(
  specId: string,
  client: Queryable = pool
): Promise<readonly RevitMapping[]> {
  try {
    const result = await client.query<RevitMappingRow>(
      `SELECT m.id, m.paragraph_id, m.revit_instance_id, m.revit_component_role,
              m.revit_param, m.direction, m.transform_type, m.transform_config, m.created_at
       FROM revit_parameter_mappings m
       JOIN paragraphs p ON p.id = m.paragraph_id
       WHERE p.spec_id = $1
       ORDER BY m.created_at ASC, m.id ASC`,
      [specId]
    );
    return result.rows.map(rowToMapping);
  } catch (err) {
    throw new DatabaseError(`getMappingsBySpec: failed for spec ${specId}`, { cause: err });
  }
}

export async function getMappingsByInstance(
  revitInstanceId: string,
  client: Queryable = pool
): Promise<readonly RevitMapping[]> {
  try {
    const result = await client.query<RevitMappingRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM revit_parameter_mappings
       WHERE revit_instance_id = $1
       ORDER BY created_at ASC, id ASC`,
      [revitInstanceId]
    );
    return result.rows.map(rowToMapping);
  } catch (err) {
    throw new DatabaseError(`getMappingsByInstance: failed for instance ${revitInstanceId}`, {
      cause: err,
    });
  }
}

export async function getMappingsByParagraph(
  paragraphId: string,
  client: Queryable = pool
): Promise<readonly RevitMapping[]> {
  try {
    const result = await client.query<RevitMappingRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM revit_parameter_mappings
       WHERE paragraph_id = $1
       ORDER BY created_at ASC, id ASC`,
      [paragraphId]
    );
    return result.rows.map(rowToMapping);
  } catch (err) {
    throw new DatabaseError(`getMappingsByParagraph: failed for paragraph ${paragraphId}`, {
      cause: err,
    });
  }
}
