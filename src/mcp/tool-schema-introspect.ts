// src/mcp/tool-schema-introspect.ts
import {
  normalizeObjectSchema,
  getObjectShape,
  safeParse,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { ToolInputSchema } from './tool-registry.js';

/**
 * Flat key set of a tool's registered `inputSchema`, via the SDK's own public
 * zod-compat surface (`normalizeObjectSchema` + `getObjectShape`) — the exact
 * functions the SDK uses internally at registration time, so this mirrors
 * production behavior exactly rather than re-deriving it. Returns an empty
 * set for `undefined` (a tool declared with no inputSchema) and for a schema
 * the SDK cannot resolve to an object shape.
 */
export function toolInputKeys(schema: ToolInputSchema | undefined): ReadonlySet<string> {
  if (schema === undefined) return new Set();
  const objectSchema = normalizeObjectSchema(schema);
  const shape = getObjectShape(objectSchema);
  return new Set(Object.keys(shape ?? {}));
}

/**
 * True iff `schema` is a full Zod schema INSTANCE (an `.extend()` result, or a
 * bare schema passed through unchanged) whose object-level `.strict()`/
 * `.check()` rules survive SDK registration intact; false iff it is a raw
 * `{ key: ZodType, ... }` shape literal (e.g. a `.shape` spread) which the SDK
 * rebuilds via `objectFromShape()` → `z.object(shape)`, silently discarding
 * any object-level rule the original schema carried.
 *
 * Implemented as reference-identity against the SDK's own normalizer:
 * `Object.is(normalizeObjectSchema(schema), schema)`. For a schema instance
 * the SDK returns the SAME reference (identity short-circuit already inside
 * `normalizeObjectSchema`); for a raw shape it builds a NEW object via
 * `objectFromShape()`, so the references differ. `Object.is` (not `===`)
 * sidesteps the two operands' unrelated Zod v3/v4 generic types — a cross-
 * library structural mismatch `===` would flag as always-false, even though
 * at runtime both sides are the same opaque schema value — without an
 * `as`-cast on either side. This touches no private zod v4 internal fields
 * and performs no unsafe cast — the comparison operates entirely on the
 * SDK's own public return value.
 */
export function isFullSchemaInstance(schema: ToolInputSchema | undefined): boolean {
  if (schema === undefined) return false;
  return Object.is(normalizeObjectSchema(schema), schema);
}

/**
 * True iff the SDK's own validation of `schema` REJECTS `value`.
 *
 * `isFullSchemaInstance()` is a structural proxy, and a proxy has a blind spot: it distinguishes a
 * raw `{ ...Schema.shape }` literal from a schema instance, but NOT `Schema.extend({...})` (rule
 * intact) from a hand-rebuilt `z.object({ ...Schema.shape, ... })` (rule GONE) — both are schema
 * instances, so a refactor to the latter drops the object-level rule with the structural check
 * still green. This closes that hole by proving the rule actually RUNS: it validates through
 * `normalizeObjectSchema` + the SDK's own `safeParse`, i.e. the exact path the SDK takes for
 * incoming tool arguments, so a counterexample the REST schema rejects must be rejected here too.
 */
export function sdkRejects(schema: ToolInputSchema | undefined, value: unknown): boolean {
  if (schema === undefined) return false;
  const objectSchema = normalizeObjectSchema(schema);
  if (objectSchema === undefined) return false;
  return !safeParse(objectSchema, value).success;
}
