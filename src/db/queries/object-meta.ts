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
