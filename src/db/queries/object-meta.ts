import type { PoolClient } from 'pg';
import { DatabaseError } from '../index.js';
import { ObjectMetaSchema } from '../../ast/index.js';
import type { NodeType, ObjectMeta } from '../../ast/index.js';

/**
 * Derive `meta.object` from the raw `paragraphs.object_data` JSONB column
 * (#300, ADR-072). Only `object`-typed rows carry object data — every other
 * node type is unconditionally undefined, even if the column somehow holds a
 * value, so a stray payload never leaks onto the wrong node type. An
 * `object`-typed row is required to validate against `ObjectMetaSchema`
 * (NULL included — an `object` node with no captured content is a
 * data-integrity fault, not a legitimate empty state); a mismatch throws a
 * loud `DatabaseError` with the Zod failure chained as `cause`, never a
 * silent drop. `context` names the calling mapper in the error, mirroring
 * parseNodeType's boundary-validation pattern (node-type.ts).
 */
export function parseObjectMeta(
  nodeType: NodeType,
  raw: unknown,
  context: string
): ObjectMeta | undefined {
  if (nodeType !== 'object') return undefined;
  const parsed = ObjectMetaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DatabaseError(`${context}: invalid object_data for node type "object"`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Persist `meta` as the `object_data` JSONB column on the `object`-typed row
 * `objectId` in spec `specId`, inside the caller's already-open transaction
 * (#519, ADR-072 decision 3 follow-on) — mirrors `bumpSpecContentVersion`'s
 * gate-free, `PoolClient`-scoped shape: no BEGIN/COMMIT here, the caller owns
 * the transaction boundary.
 *
 * `meta` is re-validated against `ObjectMetaSchema` before the write — never
 * trust an in-memory value blindly back into JSONB, the same boundary
 * discipline `parseObjectMeta` applies on the read side — and the write is
 * scoped to `node_type = 'object'` so it can never land on a row of the wrong
 * shape. A zero-rowCount result (unknown id, wrong spec, or a row that isn't
 * `object`-typed) throws loud rather than silently no-op-ing.
 */
export async function updateObjectData(
  client: PoolClient,
  specId: string,
  objectId: string,
  meta: ObjectMeta
): Promise<void> {
  const parsed = ObjectMetaSchema.safeParse(meta);
  if (!parsed.success) {
    throw new DatabaseError(`updateObjectData: invalid object_data for object ${objectId}`, {
      cause: parsed.error,
    });
  }
  try {
    const result = await client.query(
      `UPDATE paragraphs SET object_data = $1::jsonb
       WHERE id = $2 AND spec_id = $3 AND node_type = 'object'`,
      [JSON.stringify(parsed.data), objectId, specId]
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new DatabaseError(
        `updateObjectData: no object row ${objectId} found in spec ${specId} to update`
      );
    }
  } catch (err) {
    if (err instanceof DatabaseError) throw err;
    throw new DatabaseError(`updateObjectData: failed to update object ${objectId}`, {
      cause: err,
    });
  }
}
