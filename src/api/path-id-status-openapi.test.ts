// src/api/path-id-status-openapi.test.ts
//
// #568 — every REST handler migrated onto `parsePathUuid` (src/api/path-params.ts)
// can now return a 400 for a malformed uuid path param that previously fell
// through to an unmapped pg 22P02 -> 500, and POST /templates/import now
// rejects a whitespace-only name at the Zod boundary (422) instead of
// reaching the DB's CHECK constraint. openapi.yaml is the live, authoritative
// contract (ADR-026, CLAUDE.md) — this pins that every operation touched by
// that fix documents exactly the status code its handler can now return, so
// a future path-id site that skips parsePathUuid, or an openapi.yaml edit
// that drops the response, fails here instead of silently drifting. Response
// *behavior* (the handler actually returning 400/422 for a real request) is
// pinned separately, per call site, in each module's own
// *.integration.test.ts (see packages/projects/revisions/templates/
// disciplines .integration.test.ts, all tagged "(#568)").
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  loadSpec,
  resolveIfRef,
  type OpenApiDoc,
} from '../test-utils/contract/validate-response.js';

const MediaObjectSchema = z.object({ schema: z.unknown() });
const ContentSchema = z.record(z.string(), MediaObjectSchema);
const ResponseObjectSchema = z.object({
  description: z.string().optional(),
  content: ContentSchema.optional(),
});
// `responses` values are `z.unknown()`, not narrowed directly: a status like 400/404/500 is
// typically `$ref`'d to a shared `components/responses/*` entry (e.g. BadRequest) rather than
// documented inline, which bundling (#649) leaves as a literal `{ $ref }` pointer instead of
// dereference's fully-inlined response object — resolved per-status in operation()/
// expectErrorResponseSchema() before parsing into ResponseObjectSchema.
const OperationSchema = z.object({
  responses: z.record(z.string(), z.unknown()).optional(),
});

function operation(doc: OpenApiDoc, path: string, method: string): z.infer<typeof OperationSchema> {
  const raw = doc.paths[path]?.[method];
  if (raw === undefined) throw new Error(`missing openapi operation: ${method} ${path}`);
  return OperationSchema.parse(raw);
}

// The full ErrorResponse component (openapi.yaml): an object *requiring* both
// keys, with `success` pinned to false and `error` a string. Asserting the
// whole shape — not just that the two property names exist — is what stops an
// ad hoc one-off error object (optional `success`, `error: object`, …) from
// silently satisfying these tests.
const ErrorResponseShapeSchema = z.object({
  type: z.literal('object'),
  required: z.array(z.string()),
  properties: z.object({
    success: z.object({ type: z.literal('boolean'), enum: z.array(z.boolean()) }),
    error: z.object({ type: z.literal('string') }),
  }),
});

function expectErrorResponseSchema(
  doc: OpenApiDoc,
  responses: z.infer<typeof OperationSchema>['responses'],
  status: string,
  label: string
): void {
  const rawResponse = responses?.[status];
  expect(rawResponse, `${label} does not document a ${status} response`).toBeDefined();
  const response = ResponseObjectSchema.parse(resolveIfRef(doc, rawResponse));
  const rawSchema = response.content?.['application/json']?.schema;
  expect(rawSchema, `${label} ${status} has no application/json schema`).toBeDefined();
  const schema = resolveIfRef(doc, rawSchema);

  const parsed = ErrorResponseShapeSchema.safeParse(schema);
  expect(parsed.success, `${label} ${status} is not the ErrorResponse shape`).toBe(true);
  if (!parsed.success) return;
  expect(parsed.data.required, `${label} ${status} must require success + error`).toEqual(
    expect.arrayContaining(['success', 'error'])
  );
  expect(parsed.data.properties.success.enum, `${label} ${status} success must be false`).toEqual([
    false,
  ]);
}

// Every {method, path} whose handler reads a uuid-typed path param through
// parsePathUuid. Mirrors the call sites wired in router.ts — see
// src/api/projects.ts, packages.ts, revisions.ts, and specs.ts.
const PATH_ID_VALIDATED_OPS: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'get', path: '/projects/{id}' },
  { method: 'patch', path: '/projects/{id}' },
  { method: 'delete', path: '/projects/{id}' },
  { method: 'post', path: '/projects/{id}/restore' },
  { method: 'put', path: '/projects/{id}/sources' },
  { method: 'get', path: '/projects/{id}/specs' },
  { method: 'post', path: '/projects/{id}/specs' },
  { method: 'delete', path: '/projects/{id}/specs/{specId}' },
  { method: 'get', path: '/projects/{id}/references/broken' },
  { method: 'post', path: '/projects/{id}/packages' },
  { method: 'get', path: '/projects/{id}/packages' },
  { method: 'put', path: '/packages/{id}/specs' },
  { method: 'delete', path: '/packages/{id}' },
  { method: 'get', path: '/packages/{id}/revisions' },
  { method: 'post', path: '/packages/{id}/revisions' },
  { method: 'get', path: '/revisions/{id}' },
  { method: 'get', path: '/specs/{id}' },
  { method: 'patch', path: '/specs/{id}' },
];

describe('openapi.yaml documents the parsePathUuid 400 on every migrated operation (#568)', () => {
  it.each(PATH_ID_VALIDATED_OPS)(
    '$method $path documents a 400 with the ErrorResponse JSON schema',
    async ({ method, path }) => {
      const doc = await loadSpec();
      const op = operation(doc, path, method);
      // ErrorResponse always requires `success: false` + `error: string` —
      // confirm the 400 targets that shape, not some ad hoc one-off object.
      expectErrorResponseSchema(doc, op.responses, '400', `${method} ${path}`);
    }
  );
});

describe('openapi.yaml documents the shared-schema 422 on POST /templates/import (#568)', () => {
  it('documents 422 (not a second, ad hoc 400) for a name that fails CreateTemplateBodySchema', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/templates/import', 'post');
    expectErrorResponseSchema(doc, op.responses, '422', 'post /templates/import');
  });
});
