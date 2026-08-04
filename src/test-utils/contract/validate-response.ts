import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { ValidateFunction, AnySchemaObject } from 'ajv';
import { z } from 'zod';
import { markUnevaluatedPropertiesFalse } from './unevaluated-properties.js';

// Re-exported so the walker's boundary invariants (no input mutation, per-context marking) can be
// pinned from the same module surface the contract tests already import.
export { markUnevaluatedPropertiesFalse };

// ajv and ajv-formats are CJS-only packages with no exports map; under
// moduleResolution:NodeNext they must be loaded via createRequire.
const require = createRequire(import.meta.url);

interface AjvInstance {
  compile(schema: AnySchemaObject): ValidateFunction;
  errorsText(errors?: ValidateFunction['errors']): string;
}
interface AjvConstructor {
  new (opts: { strict: boolean; allErrors: boolean }): AjvInstance;
}
interface AjvPlugin {
  (ajv: AjvInstance): AjvInstance;
}

const Ajv2020 = (require('ajv/dist/2020.js') as { default: AjvConstructor }).default;
const addFormats = (require('ajv-formats') as { default: AjvPlugin }).default;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const SPEC_PATH = fileURLToPath(new URL('../../../openapi.yaml', import.meta.url));

const SchemaObject = z.record(z.string(), z.unknown());
const ResponseObject = z.object({
  content: z.record(z.string(), z.object({ schema: SchemaObject.optional() })).optional(),
});
const OperationObject = z.object({
  responses: z.record(z.string(), ResponseObject).optional(),
});

// Request-body schema, narrowed only to the shape operationParamKeys() reads: either a direct
// `properties` map, or (for the 3 `oneOf`-composed bodies — the two general-spec PUTs and
// POST /packages/{id}/revisions) a `oneOf` array of branch schemas each with their own
// `properties`. Everything else (types, formats, nested schemas) is deliberately untyped here.
const RequestBodySchemaObject = z.object({
  properties: z.record(z.string(), z.unknown()).optional(),
  oneOf: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional() })).optional(),
});
const RequestBodyContent = z.record(
  z.string(),
  z.object({ schema: RequestBodySchemaObject.optional() })
);
const ParameterObject = z.object({
  name: z.string(),
  in: z.string(),
});
const OperationWithParamsObject = z.object({
  parameters: z.array(ParameterObject).optional(),
  requestBody: z.object({ content: RequestBodyContent.optional() }).optional(),
});
const OpenApiDocSchema = z.object({
  servers: z.array(z.object({ url: z.string() })).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
export type OpenApiDoc = z.infer<typeof OpenApiDocSchema>;

const ajv: AjvInstance = addFormats(new Ajv2020({ strict: false, allErrors: true }));
const validators = new WeakMap<object, ValidateFunction>();

function normalizePath(path: string): string {
  return path.replace(/:\w+/g, '{}').replace(/\{[\w.-]+\}/g, '{}');
}

let specPromise: Promise<OpenApiDoc> | null = null;
export function loadSpec(): Promise<OpenApiDoc> {
  specPromise ??= $RefParser.dereference(SPEC_PATH).then((raw) => OpenApiDocSchema.parse(raw));
  return specPromise;
}

// Un-dereferenced parse: `$ref` pointers stay as literal `{ $ref: '#/...' }` strings rather
// than being resolved into the full (and, for recursive shapes like SpecNode, self-referential)
// target tree. Callers that only need to assert pointer identity — e.g. "this operation's
// success response still targets the SpecNode component" or "this component schema's
// `properties`/`required` set" — narrow the (deliberately untyped) result themselves, matching
// the pattern already used for `doc.paths[...]` narrowing in create-project.integration.test.ts.
let rawSpecPromise: Promise<unknown> | null = null;
export function loadRawSpec(): Promise<unknown> {
  rawSpecPromise ??= $RefParser.parse(SPEC_PATH);
  return rawSpecPromise;
}

// Exported so contract tests can compile+run an arbitrary component schema directly
// (e.g. cross-checking a request-body schema against a hand-duplicated Zod shape),
// not just a response schema reached through assertResponse.
export function getValidator(schema: AnySchemaObject): ValidateFunction {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(schema);
  validators.set(schema, compiled);
  return compiled;
}

/** Shared by assertResponse (schema-conformance) and assertResponseExact (exact-key-match): looks
 * up the operation, fails loud on the two shapes that would make an assertion pass VACUOUSLY (an
 * undocumented status; an `application/json` response documenting no schema), and returns the
 * documented `application/json` schema — or `undefined` for a documented non-JSON response
 * (binary / no-content / multipart), which both callers treat as an out-of-scope no-op.
 * Exported so those vacuity guards can be pinned against a synthetic `doc`: neither shape exists in
 * today's openapi.yaml, so neither is reachable through `assertResponse`'s real-spec surface — and
 * an unreachable guard nobody tests is exactly how a gate quietly stops gating. */
export function resolveResponseSchema(
  doc: OpenApiDoc,
  method: string,
  pathTemplate: string,
  status: number
): AnySchemaObject | undefined {
  const rawOp = doc.paths[pathTemplate]?.[method.toLowerCase()];
  if (rawOp === undefined) throw new Error(`No OpenAPI operation: ${method} ${pathTemplate}`);
  const op = OperationObject.parse(rawOp);
  // An UNDOCUMENTED status must fail loud, not fall through to the no-JSON no-op below. Collapsing
  // the two means a caller pinned to a status openapi.yaml no longer documents (e.g. a 201 changed
  // to 200) silently validates NOTHING and stays green forever — the gate quietly stops gating.
  const response = op.responses?.[String(status)];
  if (response === undefined) {
    throw new Error(
      `${method} ${pathTemplate} documents no ${status} response in openapi.yaml — the assertion ` +
        'would pass vacuously; fix the expected status or document it.'
    );
  }
  const json = response.content?.['application/json'];
  // No `application/json` media type at all — a documented binary / no-content / multipart
  // response. There is genuinely nothing to validate, so both callers no-op.
  if (json === undefined) return undefined;
  // An `application/json` response that documents NO schema is a different animal, and collapsing
  // it into the no-op above is the same vacuity bug as the undocumented-status case: successJsonOps
  // still counts the op as in-scope JSON (it keys off the media type, not the schema), so INV-5/6
  // would "validate" it against nothing and stay green forever. Fail loud instead.
  if (json.schema === undefined) {
    throw new Error(
      `${method} ${pathTemplate} documents a ${status} application/json response with no schema ` +
        'in openapi.yaml — the assertion would pass vacuously; document the response schema.'
    );
  }
  return json.schema;
}

export async function assertResponse(
  method: string,
  pathTemplate: string,
  status: number,
  body: unknown
): Promise<void> {
  const doc = await loadSpec();
  const schema = resolveResponseSchema(doc, method, pathTemplate, status);
  if (!schema) return; // documented non-JSON (binary / no-content / multipart) — out of scope
  const validate = getValidator(schema);
  if (!validate(body)) {
    throw new Error(
      `Response body for ${method} ${pathTemplate} (${status}) does not match openapi.yaml: ` +
        ajv.errorsText(validate.errors)
    );
  }
}

/** Exact-key-match variant of {@link assertResponse}: rejects any response key the openapi.yaml
 * schema doesn't document, closing the vacuous-gate hole #640 found (schema conformance alone lets
 * an undocumented extra key — e.g. `delete_package`'s `deleted`, since fixed — pass silently).
 * Compiles a FRESH, uncached ajv validator against a `structuredClone`d + augmented copy of the
 * schema — never mutates or caches through {@link getValidator}'s shared WeakMap, which INV-5's
 * `assertResponse` call site also reads and would otherwise corrupt. Same "no such op" /
 * "undocumented status" / "documented non-JSON → no-op" contract as `assertResponse`. */
export async function assertResponseExact(
  method: string,
  pathTemplate: string,
  status: number,
  body: unknown
): Promise<void> {
  const doc = await loadSpec();
  const schema = resolveResponseSchema(doc, method, pathTemplate, status);
  if (!schema) return; // documented non-JSON (binary / no-content / multipart) — out of scope
  const exactSchema = markUnevaluatedPropertiesFalse(schema);
  const validate = ajv.compile(exactSchema);
  if (!validate(body)) {
    // The exact schema still enforces `required` and field types, so a failure here is not
    // necessarily an undocumented key. Report the key-specific message only when ajv actually
    // says so; otherwise a missing required field would be misdiagnosed as an extra one.
    const extraKey = validate.errors?.some((e) => e.keyword === 'unevaluatedProperties');
    const detail = ajv.errorsText(validate.errors);
    throw new Error(
      extraKey
        ? `Response body for ${method} ${pathTemplate} (${status}) carries keys openapi.yaml does ` +
            `not document: ${detail}`
        : `Response body for ${method} ${pathTemplate} (${status}) does not match its documented ` +
            `response schema exactly: ${detail}`
    );
  }
}

export function expressRouteManifest(router: Router): string[] {
  const { stack } = router as Router & {
    stack: { route?: { path: string; methods: Record<string, boolean> } }[];
  };
  const out: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push(`${method} ${normalizePath(layer.route.path)}`);
    }
  }
  return out;
}

function eachOperation(doc: OpenApiDoc): { method: string; path: string; raw: unknown }[] {
  const out: { method: string; path: string; raw: unknown }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const raw = item[method];
      if (raw !== undefined) out.push({ method, path, raw });
    }
  }
  return out;
}

export function specOperationManifest(doc: OpenApiDoc): string[] {
  return eachOperation(doc).map(({ method, path }) => `${method} ${normalizePath(path)}`);
}

/** Maps every operation's normalized `"method /path"` key (path params collapsed to `{}` —
 * the format OP_TO_TOOL/contract-map.ts use) to its literal openapi.yaml path template, for
 * callers that need to go from a contract-map op string back to a path indexable via
 * `doc.paths`/{@link operationParamKeys}. One-to-one: openapi.yaml declares each operation once,
 * so no two literal paths collapse to the same normalized key. */
export function operationPathTemplates(doc: OpenApiDoc): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const { method, path } of eachOperation(doc)) {
    out.set(`${method} ${normalizePath(path)}`, path);
  }
  return out;
}

export function successJsonOps(doc: OpenApiDoc): string[] {
  const out: string[] = [];
  for (const { method, path, raw } of eachOperation(doc)) {
    const op = OperationObject.parse(raw);
    const has2xxJson = Object.entries(op.responses ?? {}).some(
      ([status, r]) => status.startsWith('2') && r.content?.['application/json'] !== undefined
    );
    if (has2xxJson) out.push(`${method} ${normalizePath(path)}`);
  }
  return out;
}

export interface ParamSet {
  readonly query: ReadonlySet<string>;
  readonly body: ReadonlySet<string>;
}

type RequestBodySchema = z.infer<typeof RequestBodySchemaObject>;

// Union of the direct `properties` map AND every `oneOf` branch's `properties` (the 3 composed-body
// ops), so INV-4 stays meaningful instead of passing vacuously for exactly the operations this
// helper exists to check. Unioning rather than letting a direct `properties` win outright matters
// for a schema carrying both (a discriminator alongside branch-specific fields): short-circuiting
// on the base map would drop every branch field without any signal.
function bodyPropertyKeys(schema: RequestBodySchema | undefined): ReadonlySet<string> {
  const keys = new Set(Object.keys(schema?.properties ?? {}));
  for (const branch of schema?.oneOf ?? []) {
    for (const key of Object.keys(branch.properties ?? {})) keys.add(key);
  }
  return keys;
}

// application/json wins when present; otherwise fall back to multipart/form-data (the 5
// file-upload ops). A requestBody with neither content type yields an empty set.
function requestBodyKeys(
  content: z.infer<typeof RequestBodyContent> | undefined
): ReadonlySet<string> {
  const jsonSchema = content?.['application/json']?.schema;
  if (jsonSchema !== undefined) return bodyPropertyKeys(jsonSchema);
  return bodyPropertyKeys(content?.['multipart/form-data']?.schema);
}

/** Query-param names and request-body top-level property names an operation documents in
 * openapi.yaml, for cross-checking against an MCP tool's flat `inputSchema` (INV-4). Path
 * params are deliberately excluded: REST path segments are generic (`{id}`, `{nodeId}`)
 * while MCP tools disambiguate them (`projectId`, `paragraphId`) across a flat arg list, so
 * name-matching would be systematically wrong. Throws only when `method`+`pathTemplate` is
 * not a real operation in `doc` (mirrors {@link assertResponse}'s "no such op" failure). */
export function operationParamKeys(
  doc: OpenApiDoc,
  method: string,
  pathTemplate: string
): ParamSet {
  const raw = doc.paths[pathTemplate]?.[method.toLowerCase()];
  if (raw === undefined) throw new Error(`No OpenAPI operation: ${method} ${pathTemplate}`);
  const op = OperationWithParamsObject.parse(raw);
  const query = new Set(
    (op.parameters ?? []).filter((param) => param.in === 'query').map((param) => param.name)
  );
  const body = requestBodyKeys(op.requestBody?.content);
  // Fail loud rather than hand back an empty set: a documented requestBody whose top-level keys
  // this narrow reader cannot derive (an unsupported composition — allOf, a nested anyOf, a
  // non-object body) would make INV-4 pass vacuously for that op, which is the failure mode the
  // gate exists to prevent. No current operation trips this; it fires when one is introduced.
  if (op.requestBody !== undefined && body.size === 0) {
    throw new Error(
      `${method} ${pathTemplate} documents a requestBody but no top-level properties could be ` +
        'derived from it — INV-4 would pass vacuously. Extend bodyPropertyKeys() to handle this ' +
        'schema composition.'
    );
  }
  return { query, body };
}
