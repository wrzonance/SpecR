// src/test-utils/contract/unevaluated-properties.ts
//
// The exact-key-match half of the contract gate (#640): rewrites a resolved OpenAPI response
// schema so ajv rejects any response key the schema's own subtree doesn't account for. Split out
// of validate-response.ts (400-line cap) because the JSON-Schema 2020-12 applicator rules below
// carry more commentary than the rest of that module combined.
//
// Why this exists: `assertResponse` checks schema CONFORMANCE only — no openapi.yaml response
// schema declares `additionalProperties`/`unevaluatedProperties`, so ajv silently accepts an
// undocumented extra key (the hole delete_package's stray `deleted` field sat in).
import type { AnySchemaObject } from 'ajv';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// --- Applicator classification (JSON Schema 2020-12) -------------------------------------------
//
// `unevaluatedProperties` is scoped to the annotations produced by the schema object that DECLARES
// it — its own `properties`/`patternProperties` plus whatever its in-place applicators evaluate.
// A subschema does NOT see annotations produced by its parent or its siblings. That single rule
// decides where the marker may be placed, and it splits every subschema-bearing keyword in two:
//
// IN-PLACE — the subschema is applied to the SAME instance location as its parent
// (`allOf`/`oneOf`/`anyOf`/`if`/`then`/`else`/`dependentSchemas`). Marking such a branch is a bug:
// evaluated standalone against the whole instance, it is blind to the keys its PARENT and its
// SIBLING branches evaluate, so it rejects a fully-documented payload. Concretely, marking the
// `{data: ...}` branch of the repo-wide `allOf: [SuccessResponse, {data: ...}]` envelope makes it
// reject `success`, which only the sibling branch declares. Only the node that OWNS the keyword
// may be marked — there, `unevaluatedProperties` correctly unions the annotations of every
// successful in-place applicator with the owner's own. This applies to `oneOf`/`anyOf` exactly as
// much as to `allOf`: "only one branch matches" says nothing about the parent's sibling keywords,
// and `anyOf` combines the annotations of EVERY successful branch.
//
// CHILD — the subschema is applied to a DIFFERENT instance location: a property value
// (`properties`, `patternProperties`, schema-valued `additionalProperties`/`unevaluatedProperties`)
// or an array element (`items`, `prefixItems`, `contains`). Each is evaluated standalone against
// its own sub-instance, so each is marked like any top-level schema.
//
// `not` is deliberately absent: it succeeds precisely when its subschema FAILS, its annotations are
// discarded, and injecting a marker inside it could flip the branch's result. `$ref` is NOT a
// subschema-bearing applicator the walker recurses into — since loadSpec() switched from
// dereference to bundle (issue #649), a `$ref` pointer is a genuine terminal leaf: SpecNode's own
// self-reference (`children: SpecNode[]`) would otherwise make dereference-then-walk build a
// literal circular JS object and blow ajv's compile-time traversal stack. Instead `markObject`
// below rewrites the pointer string (via `qualifyRef`) to target whichever mirror document matches
// the LOCAL context of that specific `$ref` occurrence, and leaves resolving it to ajv at
// validate-time, which walks the recursive structure lazily instead of eagerly. A `$ref` node
// evaluates no properties of its OWN (no literal `properties`/`patternProperties` etc besides the
// pointer), so `shouldMark` never marks it directly — the marking lives on the mirror entry the
// pointer targets instead.
const IN_PLACE_ARRAYS = ['allOf', 'oneOf', 'anyOf'] as const;
const IN_PLACE_SINGLES = ['if', 'then', 'else'] as const;
const IN_PLACE_MAPS = ['dependentSchemas'] as const;
const CHILD_MAPS = ['properties', 'patternProperties'] as const;
const CHILD_ARRAYS = ['prefixItems'] as const;
const CHILD_SINGLES = [
  'items',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  // `unevaluatedItems` applies to array items no other array keyword evaluated (2020-12
  // Unevaluated vocabulary), so it is a CHILD applicator like `items`/`contains` — an object
  // subschema under it evaluates properties and must be marked. Unreachable through today's
  // openapi.yaml (zero occurrences), but this list is the walker's definition of "every place a
  // subschema can hide"; omitting one keyword is how the hole this module closes reopens.
  'unevaluatedItems',
] as const;

/** Maps each visited node's ORIGINAL object identity to the (up to two) clones already computed for
 * it, keyed by the `inPlace` context each clone was computed under.
 * `$RefParser.dereference()` reuses one object instance for every `$ref` pointer targeting the same
 * component, so the identical node can legitimately be reached twice in one walk under TWO
 * DIFFERENT contexts — once as an in-place branch (must stay unmarked) and once nested under a
 * sibling's `properties`/`items` (must be marked). A plain visited-Set cannot distinguish those: it
 * conflates "already visited" with "already decided", so whichever context arrives FIRST wins and
 * the second silently no-ops. Keying by the ORIGINAL node (never mutated) rather than by whatever
 * the first visit produced also matters: a divergent-context clone must be built from the pristine
 * original, never from a sibling context's already-marked output, or that mark leaks across
 * contexts. */
type SeenContexts = Map<object, Map<boolean, Record<string, unknown>>>;

/** Rewrites a bundled `$ref` pointer (e.g. `#/components/schemas/SpecNode`) to target whichever
 * mirror document matches the LOCAL walking context (`inPlace`) the ref was encountered under.
 * The default (used whenever a caller doesn't need mirror-qualified refs — every pre-#649 call
 * site) is the identity function, so existing callers/tests are byte-for-byte unaffected. */
export type QualifyRef = (ref: string, inPlace: boolean) => string;

export interface RefQualifyOptions {
  readonly inPlace?: boolean;
  readonly qualifyRef?: QualifyRef;
}

// The two mirror documents assertResponseExact/loadSpec register with ajv (#649): CHILD_MIRROR_ID
// holds every component schema marked as if reached via a properties/items position,
// IN_PLACE_MIRROR_ID holds every component marked as if reached via an allOf/oneOf/anyOf branch
// (i.e. never marked directly — see the applicator classification above). A component referenced
// from both contexts somewhere in openapi.yaml (confirmed: SuccessResponse, ErrorResponse, and 10
// others) needs BOTH mirror entries, which is exactly why there are two documents rather than one.
export const CHILD_MIRROR_ID = 'https://specr.internal/contract/unevaluated-properties/child';
export const IN_PLACE_MIRROR_ID = 'https://specr.internal/contract/unevaluated-properties/in-place';

const LOCAL_REF_PREFIX = '#/';

/** Standard `qualifyRef` for the two component mirrors: rewrites a local `#/...` pointer to
 * `<mirrorId>#/...`, choosing the mirror by the LOCAL context the pointer was found in — never the
 * top-level call's own `inPlace`, which is what lets one component serve both contexts correctly. */
export function buildMirrorQualifyRef(): QualifyRef {
  return (ref, inPlace) => {
    if (!ref.startsWith(LOCAL_REF_PREFIX)) {
      throw new Error(`markUnevaluatedPropertiesFalse: unsupported non-local $ref "${ref}"`);
    }
    return `${inPlace ? IN_PLACE_MIRROR_ID : CHILD_MIRROR_ID}${ref}`;
  };
}

function walkMap(
  schema: Record<string, unknown>,
  key: string,
  seen: SeenContexts,
  inPlace: boolean,
  qualifyRef: QualifyRef
): void {
  const map = schema[key];
  if (!isPlainObject(map)) return;
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(map)) out[name] = mark(sub, seen, inPlace, qualifyRef);
  schema[key] = out;
}

function walkArray(
  schema: Record<string, unknown>,
  key: string,
  seen: SeenContexts,
  inPlace: boolean,
  qualifyRef: QualifyRef
): void {
  const branches = schema[key];
  if (!Array.isArray(branches)) return;
  schema[key] = branches.map((branch) => mark(branch, seen, inPlace, qualifyRef));
}

function walkSingle(
  schema: Record<string, unknown>,
  key: string,
  seen: SeenContexts,
  inPlace: boolean,
  qualifyRef: QualifyRef
): void {
  const sub = schema[key];
  if (!isPlainObject(sub)) return;
  schema[key] = mark(sub, seen, inPlace, qualifyRef);
}

function walkSubschemas(
  schema: Record<string, unknown>,
  seen: SeenContexts,
  qualifyRef: QualifyRef
): void {
  for (const key of CHILD_MAPS) walkMap(schema, key, seen, false, qualifyRef);
  for (const key of IN_PLACE_MAPS) walkMap(schema, key, seen, true, qualifyRef);
  for (const key of CHILD_ARRAYS) walkArray(schema, key, seen, false, qualifyRef);
  for (const key of IN_PLACE_ARRAYS) walkArray(schema, key, seen, true, qualifyRef);
  for (const key of CHILD_SINGLES) walkSingle(schema, key, seen, false, qualifyRef);
  for (const key of IN_PLACE_SINGLES) walkSingle(schema, key, seen, true, qualifyRef);
}

/** True when this schema object itself evaluates object properties — via its own
 * `properties`/`patternProperties`, or via an in-place applicator it OWNS. Marking a node that
 * evaluates nothing would reject every key of an otherwise-unconstrained object. */
function evaluatesProperties(schema: Record<string, unknown>): boolean {
  if (isPlainObject(schema['properties']) || isPlainObject(schema['patternProperties']))
    return true;
  if (isPlainObject(schema['dependentSchemas']) || isPlainObject(schema['if'])) return true;
  return IN_PLACE_ARRAYS.some((key) => Array.isArray(schema[key]));
}

function shouldMark(schema: Record<string, unknown>, inPlace: boolean): boolean {
  if (inPlace) return false;
  // An explicit `additionalProperties`/`unevaluatedProperties` is a deliberate openness (or
  // strictness) decision already made by openapi.yaml — and when `additionalProperties` is present
  // it evaluates every remaining key, so an added `unevaluatedProperties` could never fire anyway.
  if ('additionalProperties' in schema || 'unevaluatedProperties' in schema) return false;
  return evaluatesProperties(schema);
}

function markObject(
  node: Record<string, unknown>,
  seen: SeenContexts,
  inPlace: boolean,
  qualifyRef: QualifyRef
): Record<string, unknown> {
  const contexts = seen.get(node);
  const cached = contexts?.get(inPlace);
  // Same original node, same context: either a true cycle (a schema that is its own ancestor
  // through some OTHER shared-identity path — see the "two different composition contexts" tests)
  // or a harmless duplicate reference already processed for this context. Either way the existing
  // (in-progress or finished) clone is the right answer. `$ref` pointers themselves no longer create
  // this kind of cycle post-#649 (see the applicator-classification comment above): a bundled `$ref`
  // is a small, non-shared literal object rewritten in place, never resolved into its target here.
  if (cached !== undefined) return cached;
  // Always build a fresh SHALLOW clone from the pristine original `node` — never mutate it, and
  // never derive one context's clone from another context's already-processed output (that would
  // leak the sibling's mark across contexts). The shallow copy suffices because every nested key
  // touched below is REASSIGNED to a brand-new value from a recursive call, never mutated in place.
  const schema: Record<string, unknown> = { ...node };
  // A bundled `$ref` pointer: rewrite it to the mirror-qualified id for THIS local context and stop
  // — it has no other subschema-bearing keywords worth walking (siblings like `description` are
  // plain data), and `shouldMark` below naturally leaves it unmarked since it evaluates no
  // properties of its own (see the `$ref` note in the applicator-classification comment).
  if (typeof schema['$ref'] === 'string') schema['$ref'] = qualifyRef(schema['$ref'], inPlace);
  // Register the in-progress clone under its context BEFORE recursing, so a schema reached again
  // under the SAME context (the shared-object-identity case above) returns this clone instead of
  // recursing forever.
  const perNode = contexts ?? new Map<boolean, Record<string, unknown>>();
  perNode.set(inPlace, schema);
  seen.set(node, perNode);
  walkSubschemas(schema, seen, qualifyRef);
  if (shouldMark(schema, inPlace)) schema['unevaluatedProperties'] = false;
  return schema;
}

/** Clones `schema` and injects `unevaluatedProperties: false` into every node that evaluates
 * properties at its own instance location (see the applicator classification above). Never mutates
 * its input — the returned tree is always a fresh clone, safe to compile through an uncached ajv
 * instance without corrupting any other reader of the original schema object. */
function mark(
  node: unknown,
  seen: SeenContexts,
  inPlace: boolean,
  qualifyRef: QualifyRef
): unknown {
  return isPlainObject(node) ? markObject(node, seen, inPlace, qualifyRef) : node;
}

const IDENTITY_QUALIFY_REF: QualifyRef = (ref) => ref;

export function markUnevaluatedPropertiesFalse(
  schema: AnySchemaObject,
  options: RefQualifyOptions = {}
): AnySchemaObject {
  // No assertion at this boundary (CLAUDE.md): `markObject` is typed to return an object, and
  // `AnySchemaObject` is structurally a `Record<string, unknown>`, so the return type is proven
  // by the signature rather than asserted over an `unknown`.
  const inPlace = options.inPlace ?? false;
  const qualifyRef = options.qualifyRef ?? IDENTITY_QUALIFY_REF;
  return markObject(structuredClone(schema), new Map(), inPlace, qualifyRef);
}
