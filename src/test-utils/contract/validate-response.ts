import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import type { ValidateFunction, AnySchemaObject } from 'ajv';
import { z } from 'zod';

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

function getValidator(schema: AnySchemaObject): ValidateFunction {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(schema);
  validators.set(schema, compiled);
  return compiled;
}

export async function assertResponse(
  method: string,
  pathTemplate: string,
  status: number,
  body: unknown
): Promise<void> {
  const doc = await loadSpec();
  const rawOp = doc.paths[pathTemplate]?.[method.toLowerCase()];
  if (rawOp === undefined) throw new Error(`No OpenAPI operation: ${method} ${pathTemplate}`);
  const op = OperationObject.parse(rawOp);
  const schema = op.responses?.[String(status)]?.content?.['application/json']?.schema;
  if (!schema) return; // non-JSON (binary / 204 / multipart) — out of scope
  const validate = getValidator(schema);
  if (!validate(body)) {
    throw new Error(
      `Response body for ${method} ${pathTemplate} (${status}) does not match openapi.yaml: ` +
        ajv.errorsText(validate.errors)
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
