import { DatabaseError } from '../index.js';
import { NodeTypeSchema } from '../../ast/index.js';
import type { NodeType } from '../../ast/index.js';

/** Validate a raw DB `node_type` string against the canonical AST enum before it
 *  crosses into a `SpecNode`. `paragraphs.node_type` is a varchar with no CHECK,
 *  so a non-enum value is representable — this guards against drift between the
 *  DB column and the AST type without a cross-boundary assertion, failing loud
 *  (never a silent cast). Shared by the tree and subtree row mappers
 *  (specs.ts buildNodeTree, paragraphs.ts buildSubtree); `context` names the
 *  calling mapper in the error. */
export function parseNodeType(nodeType: string, context: string): NodeType {
  const parsed = NodeTypeSchema.safeParse(nodeType);
  if (!parsed.success) {
    throw new DatabaseError(`${context}: unexpected node_type "${nodeType}"`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
