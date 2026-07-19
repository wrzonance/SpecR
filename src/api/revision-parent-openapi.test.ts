// src/api/revision-parent-openapi.test.ts
//
// ADR-066 (#389) — package_revisions.parent_revision_id. openapi.yaml is the
// hand-authored, live contract (ADR-026): src/db/queries/revisions.ts and
// revision-parent.ts already thread parentRevisionId through every read/write
// surface, and src/ast/revision-schemas.ts already accepts it on the
// structured create body. The generic route<->op coverage gate in
// contract.integration.test.ts allowlists POST /packages/{id}/revisions,
// GET /revisions/{id}, and GET /packages/{id}/revisions for schema-level
// checking (not yet promoted to RESPONSE_COVERED), so it cannot by itself
// catch a doc that forgets the field. This file pins parentRevisionId
// directly against the dereferenced spec so a future shape change to any of
// those modules without a matching openapi.yaml edit fails here first.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { loadSpec, type OpenApiDoc } from '../test-utils/contract/validate-response.js';

const JsonSchemaObjectSchema = z.object({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  format: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
});
type JsonSchemaObject = z.infer<typeof JsonSchemaObjectSchema>;

const MediaObjectSchema = z.object({ schema: z.unknown() });
const ContentSchema = z.record(z.string(), MediaObjectSchema);
const ResponseObjectSchema = z.object({
  description: z.string().optional(),
  content: ContentSchema.optional(),
});
const OperationSchema = z.object({
  requestBody: z.object({ content: ContentSchema }).optional(),
  responses: z.record(z.string(), ResponseObjectSchema).optional(),
});

function operation(doc: OpenApiDoc, path: string, method: string): z.infer<typeof OperationSchema> {
  const raw = doc.paths[path]?.[method];
  if (raw === undefined) throw new Error(`missing openapi operation: ${method} ${path}`);
  return OperationSchema.parse(raw);
}

function jsonSchemaOf(content: z.infer<typeof ContentSchema> | undefined): unknown {
  const media = content?.['application/json'];
  if (media === undefined) throw new Error('operation has no application/json content');
  return media.schema;
}

/** Picks the oneOf/allOf branch whose `required` list names `field` — order-independent. */
function branchRequiring(branches: readonly unknown[], field: string): JsonSchemaObject {
  const match = branches
    .map((b) => JsonSchemaObjectSchema.parse(b))
    .find((b) => (b.required ?? []).includes(field));
  if (match === undefined) throw new Error(`no schema branch requires "${field}"`);
  return match;
}

/** Unwraps `data` out of the `allOf: [SuccessResponse, { data }]` envelope. */
function dataSchemaOf(schema: unknown): unknown {
  const allOf = z.object({ allOf: z.array(z.unknown()) }).parse(schema).allOf;
  const holder = branchRequiring(allOf, 'data');
  const properties = holder.properties;
  if (properties === undefined) throw new Error('data-bearing branch has no properties');
  return properties['data'];
}

function itemsOf(schema: unknown): unknown {
  return z.object({ items: z.unknown() }).parse(schema).items;
}

function expectNullableUuidField(schema: JsonSchemaObject, field: string): void {
  const prop = JsonSchemaObjectSchema.parse((schema.properties ?? {})[field]);
  expect(prop.type, `${field}.type`).toEqual(['string', 'null']);
  expect(prop.format, `${field}.format`).toBe('uuid');
  expect(schema.required ?? [], `${field} must be required`).toContain(field);
}

describe('openapi.yaml — package_revisions.parent_revision_id (ADR-066 #389)', () => {
  it('CreateRevisionStructuredBody accepts an optional parentRevisionId (uuid)', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'post');
    const oneOf = z
      .object({ oneOf: z.array(z.unknown()) })
      .parse(jsonSchemaOf(op.requestBody?.content)).oneOf;
    const structured = branchRequiring(oneOf, 'type');
    const prop = JsonSchemaObjectSchema.parse((structured.properties ?? {})['parentRevisionId']);
    expect(prop.type).toBe('string');
    expect(prop.format).toBe('uuid');
    expect(structured.required ?? []).not.toContain('parentRevisionId');
  });

  it('CreateRevisionLegacyBody has no parentRevisionId — matches its .strict() Zod counterpart', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'post');
    const oneOf = z
      .object({ oneOf: z.array(z.unknown()) })
      .parse(jsonSchemaOf(op.requestBody?.content)).oneOf;
    const legacy = branchRequiring(oneOf, 'label');
    expect(legacy.properties ?? {}).not.toHaveProperty('parentRevisionId');
  });

  it('RevisionSummary requires parentRevisionId as a nullable uuid (POST .../revisions 201)', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'post');
    const revisionSummary = JsonSchemaObjectSchema.parse(
      dataSchemaOf(jsonSchemaOf(op.responses?.['201']?.content))
    );
    expectNullableUuidField(revisionSummary, 'parentRevisionId');
  });

  it('RevisionSummary requires parentRevisionId on every list item (GET .../revisions 200)', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'get');
    const arraySchema = dataSchemaOf(jsonSchemaOf(op.responses?.['200']?.content));
    const itemSchema = JsonSchemaObjectSchema.parse(itemsOf(arraySchema));
    expectNullableUuidField(itemSchema, 'parentRevisionId');
  });

  it('RevisionWithTrees requires parentRevisionId as a nullable uuid (GET /revisions/{id})', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/revisions/{id}', 'get');
    const revisionWithTrees = JsonSchemaObjectSchema.parse(
      dataSchemaOf(jsonSchemaOf(op.responses?.['200']?.content))
    );
    expectNullableUuidField(revisionWithTrees, 'parentRevisionId');
  });

  it('the 422 response documents an invalid parentRevisionId as a rejection cause', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'post');
    const description = op.responses?.['422']?.description ?? '';
    // Pin the custody rule's actual content and direction, not just that the
    // words "parent revision" appear somewhere — a rewrite that garbles or
    // inverts a clause (e.g. "belongs to the SAME package") would still
    // match a bare /parent revision/i check.
    expect(description).toMatch(/parentRevisionId fails a custody rule/i);
    expect(description).toMatch(/parent revision does not exist/i);
    expect(description).toMatch(/belongs to a different package/i);
    expect(description).not.toMatch(/belongs to the same package/i);
    expect(description).toMatch(/nesting depth cannot exceed 1/i);
  });
});

describe('openapi.yaml — package_revisions.base_revision_id (ADR-066 #390)', () => {
  it('accepts baseRevisionId only on the structured create body', async () => {
    const doc = await loadSpec();
    const op = operation(doc, '/packages/{id}/revisions', 'post');
    const branches = z
      .object({ oneOf: z.array(z.unknown()) })
      .parse(jsonSchemaOf(op.requestBody?.content)).oneOf;
    const structured = branchRequiring(branches, 'type');
    const base = JsonSchemaObjectSchema.parse((structured.properties ?? {})['baseRevisionId']);
    expect(base.type).toBe('string');
    expect(base.format).toBe('uuid');
    expect(structured.required ?? []).not.toContain('baseRevisionId');
    expect(branchRequiring(branches, 'label').properties ?? {}).not.toHaveProperty('baseRevisionId');
  });

  it.each([
    ['/packages/{id}/revisions', 'post', false],
    ['/packages/{id}/revisions', 'get', true],
    ['/revisions/{id}', 'get', false],
  ] as const)('%s %s requires nullable baseRevisionId on its response', async (path, method, list) => {
    const doc = await loadSpec();
    const op = operation(doc, path, method);
    const dataSchema = dataSchemaOf(
      jsonSchemaOf(op.responses?.[method === 'post' ? '201' : '200']?.content)
    );
    const responseSchema = JsonSchemaObjectSchema.parse(list ? itemsOf(dataSchema) : dataSchema);
    expectNullableUuidField(responseSchema, 'baseRevisionId');
  });

  it('documents stored-default generation and explicit-request precedence', async () => {
    const doc = await loadSpec();
    const generate = operation(doc, '/revisions/{id}/generate', 'post');
    const raw = doc.paths['/revisions/{id}/generate']?.['post'];
    const description = z.object({ description: z.string() }).parse(raw).description;
    expect(description).toMatch(/request `baseRevisionId` when supplied/i);
    expect(description).toMatch(/stored `baseRevisionId`/i);
    const request = JsonSchemaObjectSchema.parse(jsonSchemaOf(generate.requestBody?.content));
    const base = JsonSchemaObjectSchema.parse((request.properties ?? {})['baseRevisionId']);
    expect(base.format).toBe('uuid');
  });
});
