import { describe, it, expect } from 'vitest';
import {
  assertResponse,
  specOperationManifest,
  successJsonOps,
  loadSpec,
  loadRawSpec,
} from './validate-response.js';

// Narrow shape for the raw (un-dereferenced) request-body schema a #377 write op documents.
interface RawRequestBodySchema {
  properties?: Record<string, unknown>;
  required?: string[];
}
interface RawOperation {
  requestBody?: {
    required?: boolean;
    content: { 'application/json': { schema: RawRequestBodySchema } };
  };
  responses: Record<string, unknown>;
}
interface RawPaths {
  paths: Record<string, Partial<Record<'get' | 'post' | 'put' | 'patch' | 'delete', RawOperation>>>;
  components: {
    schemas: Record<string, RawRequestBodySchema & { additionalProperties?: boolean }>;
  };
}

describe('contract validate-response helper', () => {
  it('accepts a body that matches the documented schema', async () => {
    const body = { success: true, data: { db: 'connected', uptime: 5 } };
    await expect(assertResponse('get', '/health', 200, body)).resolves.toBeUndefined();
  });

  it('rejects a body that violates the documented schema', async () => {
    const body = { success: true }; // missing required `data`
    await expect(assertResponse('get', '/health', 200, body)).rejects.toThrow(/does not match/);
  });

  it('no-ops for an operation without a JSON response schema', async () => {
    // 204 No Content has no application/json schema
    await expect(
      assertResponse('delete', '/specs/{id}/lock', 204, undefined)
    ).resolves.toBeUndefined();
  });

  it('normalizes path params to {} so manifests are param-name agnostic', async () => {
    const doc = await loadSpec();
    expect(specOperationManifest(doc)).toContain('get /specs/{}');
    expect(successJsonOps(doc)).toContain('get /health');
  });
});

// INV-5 (#403) drives an MCP tool, wraps its BARE payload as the REST envelope
// `{ success: true, data: <payload> }`, and reuses assertResponse to validate it against the
// mapped op's OpenAPI response schema. These pin that the reuse has teeth for an array-typed
// `data` schema (the shape the driven list-read tools return) — a malformed payload must fail.
describe('INV-5 envelope-wrap reuse (assertResponse teeth)', () => {
  it('rejects a malformed enveloped tool payload against an array data schema', async () => {
    // GET /projects `data` is an array of ProjectListItem — a string must not validate.
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: 'not-an-array' })
    ).rejects.toThrow(/does not match/i);
  });

  it('accepts a well-formed enveloped tool payload against an array data schema', async () => {
    await expect(
      assertResponse('get', '/projects', 200, { success: true, data: [] })
    ).resolves.toBeUndefined();
  });
});

// #377 — actorLabel is threaded through 5 write call sites purely as an additive request
// field; these tests pin the openapi.yaml side of that: the 4 existing request bodies (plus
// the MergeRequest component, which is `additionalProperties: false` and would otherwise
// reject a caller-supplied actorLabel outright) document the new optional field, accept-as-note
// gains its first-ever requestBody, and — the invariant this work must never violate — every
// touched operation's success-response shape is byte-identical to its pre-#377 form. Raw
// (un-dereferenced) parsing keeps the response fingerprint a small `$ref` pointer / inline
// literal instead of SpecNode's full (self-referential) resolved tree.
describe('actorLabel additive request coverage (#377)', () => {
  interface DataEnvelopeResponse {
    content: {
      'application/json': {
        schema: { allOf: [unknown, { required: string[]; properties: { data: unknown } }] };
      };
    };
  }

  function successDataSchema(op: RawOperation, status: string): unknown {
    const res = op.responses[status] as DataEnvelopeResponse;
    return res.content['application/json'].schema.allOf[1].properties.data;
  }

  function sortedStatusCodes(op: RawOperation): string[] {
    return Object.keys(op.responses).sort((a, b) => a.localeCompare(b));
  }

  const WRITE_OPS = [
    {
      op: 'insertParagraph',
      path: '/specs/{id}/paragraphs',
      method: 'post' as const,
      successStatus: '201',
      statuses: ['201', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
    {
      op: 'updateParagraph',
      path: '/specs/{id}/paragraphs/{nodeId}',
      method: 'patch' as const,
      successStatus: '200',
      // 422 added (#519, ADR-072 decision 3): a direct write to a locked
      // `object` row is rejected — its content is a captured OOXML blob,
      // editable only through its `objectText` children.
      statuses: ['200', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
    {
      op: 'removeParagraph',
      path: '/specs/{id}/paragraphs/{nodeId}/removal',
      method: 'patch' as const,
      successStatus: '200',
      statuses: ['200', '400', '403', '404', '409', '422', '500'],
      successDataRef: { $ref: '#/components/schemas/SpecNode' },
    },
  ];

  it.each(WRITE_OPS)(
    '$op request body documents an optional actorLabel',
    async ({ path, method, successStatus, statuses, successDataRef }) => {
      const raw = (await loadRawSpec()) as RawPaths;
      const op = raw.paths[path]?.[method];
      if (!op) throw new Error(`no raw operation at ${method} ${path}`);
      const schema = op.requestBody?.content['application/json'].schema;
      expect(schema?.properties?.['actorLabel'], 'actorLabel property documented').toBeDefined();
      expect(schema?.required ?? [], 'actorLabel is optional, not required').not.toContain(
        'actorLabel'
      );

      // Invariant: this op's response shape is untouched by the request-body addition.
      expect(sortedStatusCodes(op)).toEqual([...statuses].sort((a, b) => a.localeCompare(b)));
      expect(successDataSchema(op, successStatus)).toEqual(successDataRef);
    }
  );

  // mergeSpecDiff's requestBody is `$ref: MergeRequest` (a shared component, not an inline
  // schema), so actorLabel lives on the component — asserted separately below — while this
  // pins the op itself still points at that same component and its response is untouched.
  it('mergeSpecDiff requestBody still points at MergeRequest; response shape untouched', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const op = raw.paths['/specs/{id}/merge']?.post;
    if (!op) throw new Error('no raw operation at post /specs/{id}/merge');
    expect(op.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/MergeRequest',
    });
    expect(sortedStatusCodes(op)).toEqual(['200', '400', '404', '409', '500']);
    expect(successDataSchema(op, '200')).toEqual({ $ref: '#/components/schemas/MergeResult' });
  });

  it('MergeRequest is additionalProperties:false and must list actorLabel explicitly', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const mergeRequest = raw.components.schemas['MergeRequest'];
    if (!mergeRequest) throw new Error('MergeRequest component missing from openapi.yaml');
    expect(mergeRequest.additionalProperties).toBe(false);
    expect(mergeRequest.properties?.['actorLabel']).toBeDefined();
    expect(mergeRequest.required ?? []).not.toContain('actorLabel');
  });

  it('acceptCommentAsNote gains its first requestBody, optional, actorLabel-only', async () => {
    const raw = (await loadRawSpec()) as RawPaths;
    const path = '/specs/{id}/paragraphs/{nodeId}/comments/{index}/accept-as-note';
    const op = raw.paths[path]?.post;
    if (!op) throw new Error(`no raw operation at post ${path}`);
    expect(op.requestBody, 'requestBody now documented').toBeDefined();
    expect(op.requestBody?.required, 'body stays optional (route was bodyless pre-#377)').not.toBe(
      true
    );
    const schema = op.requestBody?.content['application/json'].schema;
    expect(schema?.properties?.['actorLabel']).toBeDefined();
    expect(schema?.required ?? []).not.toContain('actorLabel');

    // Invariant: the 201 response shape (noteId) is untouched by the new requestBody.
    expect(sortedStatusCodes(op)).toEqual(['201', '400', '403', '404', '409', '422', '500']);
    expect(successDataSchema(op, '201')).toEqual({
      type: 'object',
      required: ['noteId'],
      properties: { noteId: { type: 'string', format: 'uuid' } },
    });
  });
});
