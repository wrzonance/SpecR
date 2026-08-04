// src/test-utils/contract/schema-refs.ts
//
// #649 — validate-response.ts switched loadSpec() from $RefParser.dereference to .bundle so ajv
// can compile the self-referential SpecNode/SpecTree response schemas (dereference materializes a
// real circular JS object for them, which blows ajv's compile-time traversal stack). Bundling keeps
// every `$ref` as a literal `{ $ref: '#/...' }` pointer instead of inlining it, which shifts the
// work here: registering documents with ajv under stable ids so those pointers resolve at
// compile/validate time, and giving callers a way to resolve one level of `$ref` themselves when
// they need to inspect a component's actual shape (not just validate a body against it). Split out
// of validate-response.ts (400-line cap) as its own cohesive concern.
import type { AnySchemaObject } from 'ajv';
import { markUnevaluatedPropertiesFalse, buildMirrorQualifyRef } from './unevaluated-properties.js';
import { CHILD_MIRROR_ID, IN_PLACE_MIRROR_ID } from './unevaluated-properties.js';
import type { OpenApiDoc } from './validate-response.js';

/** The bundled document itself, registered once with ajv so a plain-conformance (assertResponse)
 * response schema's qualified `$ref` (see {@link qualifyRefs}) can resolve against it at compile
 * time — the assertResponse counterpart to the two exact-match component mirrors below. */
export const DOC_SCHEMA_ID = 'https://specr.internal/contract/validate-response/doc';

type ComponentKind = 'schemas' | 'responses' | 'parameters';
const COMPONENT_REF_PATTERN = /^#\/components\/(schemas|responses|parameters)\/([^/]+)$/;

/** Resolves ONE level of a local `#/components/{schemas,responses,parameters}/Name` pointer
 * against `doc`, or returns `value` unchanged when it isn't a `$ref` object. Exported for
 * consumers that need to inspect a component's actual shape directly (rather than validate a real
 * response body against it) — #649: bundling leaves these as literal `{ $ref }` pointers instead
 * of dereference's fully-inlined target. Throws on a non-local or dangling ref rather than
 * returning `undefined`, matching this module's fail-loud posture for a gate that would otherwise
 * silently stop checking anything. */
export function resolveIfRef(doc: OpenApiDoc, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const ref = (value as Record<string, unknown>)['$ref'];
  if (typeof ref !== 'string') return value;
  const match = COMPONENT_REF_PATTERN.exec(ref);
  if (match === null) {
    throw new Error(`resolveIfRef: unsupported $ref "${ref}" — only local #/components/* refs`);
  }
  const kind = match[1] as ComponentKind;
  const name = match[2] as string;
  const target = doc.components?.[kind]?.[name];
  if (target === undefined) {
    throw new Error(`resolveIfRef: openapi.yaml has no components.${kind}.${name} (ref "${ref}")`);
  }
  return target;
}

/** Deep-clones `schema` and rewrites every local `$ref` string (`#/...`) to `${toId}#/...`, so it
 * resolves against whatever document was registered with ajv under `toId`. Never inlines/resolves
 * the ref target itself — inlining a self-referential target (e.g. SpecNode) would reproduce the
 * exact circular-JS-object shape that made ajv's traversal stack overflow before #649. Throws on a
 * non-local ref instead of silently leaving it unqualified (which would let it accidentally resolve
 * against the wrong document by URI-shape coincidence). */
export function qualifyRefs(schema: AnySchemaObject, toId: string): AnySchemaObject {
  return qualifyRefValue(schema, toId) as AnySchemaObject;
}

function qualifyRefValue(value: unknown, toId: string): unknown {
  if (Array.isArray(value)) return value.map((item) => qualifyRefValue(item, toId));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === '$ref' && typeof val === 'string') {
      if (!val.startsWith('#/')) {
        throw new Error(`qualifyRefs: unsupported non-local $ref "${val}"`);
      }
      out[key] = `${toId}${val}`;
    } else {
      out[key] = qualifyRefValue(val, toId);
    }
  }
  return out;
}

/** Minimal slice of the ajv instance this module needs — kept narrow so this file doesn't have to
 * re-declare the CJS-interop typing dance validate-response.ts does for the full instance. */
export interface AjvSchemaRegistry {
  addSchema(schema: AnySchemaObject, key: string): unknown;
}

/** Builds and registers the two exact-match component mirrors (#649): every `components.schemas`
 * entry marked once as if reached via a CHILD position (properties/items) and once as if reached
 * via an IN_PLACE position (allOf/oneOf/anyOf branch). Both are built eagerly for every component
 * name — no dependency worklist needed, since ajv resolves `$ref` lazily by registered id at
 * compile/validate time, never at registration time. A single "mark once, context-agnostic" mirror
 * was tried and rejected: at least 12 real components (SuccessResponse, ErrorResponse, and others)
 * are referenced from BOTH contexts somewhere in openapi.yaml, and marking SuccessResponse
 * standalone made it reject the sibling `data` branch's own keys — a false rejection of a fully
 * documented payload, not just a missed detection. */
export function registerComponentMirrors(ajv: AjvSchemaRegistry, doc: OpenApiDoc): void {
  const componentSchemas = doc.components?.schemas ?? {};
  const qualifyRef = buildMirrorQualifyRef();
  const childMirror: Record<string, AnySchemaObject> = {};
  const inPlaceMirror: Record<string, AnySchemaObject> = {};
  for (const [name, componentSchema] of Object.entries(componentSchemas)) {
    const schema = componentSchema as AnySchemaObject;
    childMirror[name] = markUnevaluatedPropertiesFalse(schema, { inPlace: false, qualifyRef });
    inPlaceMirror[name] = markUnevaluatedPropertiesFalse(schema, { inPlace: true, qualifyRef });
  }
  ajv.addSchema({ components: { schemas: childMirror } }, CHILD_MIRROR_ID);
  ajv.addSchema({ components: { schemas: inPlaceMirror } }, IN_PLACE_MIRROR_ID);
}
