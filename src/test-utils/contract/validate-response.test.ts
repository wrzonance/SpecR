import { describe, it, expect } from 'vitest';
import {
  assertResponse,
  specOperationManifest,
  successJsonOps,
  loadSpec,
  loadRawSpec,
  operationParamKeys,
} from './validate-response.js';
import type { OpenApiDoc } from './validate-response.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

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

  it('no-ops for a DOCUMENTED response that has no JSON schema', async () => {
    // DELETE /templates/{id} documents 204 with no content at all
    await expect(
      assertResponse('delete', '/templates/{id}', 204, undefined)
    ).resolves.toBeUndefined();
  });

  it('rejects a status the operation does not document, instead of passing vacuously', async () => {
    // DELETE /specs/{id}/lock documents 200 (not 204). Treating an undocumented status as a
    // "no JSON schema" no-op would validate nothing and stay green forever.
    await expect(assertResponse('delete', '/specs/{id}/lock', 204, undefined)).rejects.toThrow(
      /documents no 204 response/
    );
  });

  it('normalizes path params to {} so manifests are param-name agnostic', async () => {
    const doc = await loadSpec();
    expect(specOperationManifest(doc)).toContain('get /specs/{}');
    expect(successJsonOps(doc)).toContain('get /health');
  });
});

// operationParamKeys() feeds INV-4; anything it silently under-reports becomes an INV-4 check that
// passes vacuously. Synthetic docs (no such op exists in openapi.yaml yet) pin the two ways that
// could happen: a body carrying BOTH a base `properties` map and `oneOf` branches, and a body
// composed in a way this narrow reader cannot destructure at all.
describe('operationParamKeys body-key derivation', () => {
  function docWithBodySchema(schema: unknown): OpenApiDoc {
    return {
      paths: {
        '/synthetic': {
          post: { requestBody: { content: { 'application/json': { schema } } }, responses: {} },
        },
      },
    };
  }

  it('unions base properties with every oneOf branch instead of letting the base win', () => {
    const doc = docWithBodySchema({
      properties: { kind: {} },
      oneOf: [{ properties: { branchA: {} } }, { properties: { branchB: {} } }],
    });
    const { body } = operationParamKeys(doc, 'post', '/synthetic');
    expect([...body].sort((a, b) => a.localeCompare(b))).toEqual(['branchA', 'branchB', 'kind']);
  });

  it('throws for a documented requestBody whose top-level keys cannot be derived', () => {
    // allOf composition is not destructured by this reader — returning {} would make INV-4 green
    // for an operation whose params were never actually compared.
    const doc = docWithBodySchema({ allOf: [{ properties: { hidden: {} } }] });
    expect(() => operationParamKeys(doc, 'post', '/synthetic')).toThrow(/pass vacuously/);
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

// #549 — operationParamKeys() feeds INV-4 (MCP tool inputSchema vs. its mapped REST op).
// These pin the boundary invariants: total over every real op, never vacuously empty for an
// op with a real requestBody, plus one worked example per source branch (direct properties,
// oneOf union, multipart fallback) and the unknown-op failure mode.
describe('operationParamKeys()', () => {
  it('throws for a method+path that is not a real operation', async () => {
    const doc = await loadSpec();
    expect(() => operationParamKeys(doc, 'get', '/not-a-real-path')).toThrow(
      /No OpenAPI operation: get \/not-a-real-path/
    );
  });

  it('is total: never throws for any real operation in openapi.yaml', async () => {
    const doc = await loadSpec();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        if (item[method] === undefined) continue;
        expect(() => operationParamKeys(doc, method, path)).not.toThrow();
      }
    }
  });

  it('is never vacuously empty for an operation with a real requestBody', async () => {
    const doc = await loadSpec();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of HTTP_METHODS) {
        const raw = item[method] as { requestBody?: { content?: unknown } } | undefined;
        if (raw?.requestBody?.content === undefined) continue;
        const { body } = operationParamKeys(doc, method, path);
        expect(body.size, `${method} ${path} requestBody yields no keys`).toBeGreaterThan(0);
      }
    }
  });

  it('collects operation-level query param names', async () => {
    const doc = await loadSpec();
    const { query } = operationParamKeys(doc, 'get', '/search');
    expect(query).toEqual(
      new Set(['q', 'libraryId', 'projectId', 'division', 'part', 'nodeType', 'limit'])
    );
  });

  it('excludes path params — they are not documented under `parameters[].in === query`', async () => {
    const doc = await loadSpec();
    const { query } = operationParamKeys(doc, 'get', '/specs/{id}');
    expect(query.has('id')).toBe(false);
  });

  it('unions oneOf branch properties for a composed request body', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(
      doc,
      'put',
      '/libraries/{libraryId}/divisions/{division}/general-spec'
    );
    expect(body).toEqual(new Set(['generalSpecId', 'notes', 'status']));
  });

  it('reads direct top-level properties for a plain JSON request body', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(doc, 'post', '/specs/{id}/paragraphs');
    expect(body.has('actorLabel')).toBe(true);
  });

  it('falls back to multipart/form-data properties for a file-upload op', async () => {
    const doc = await loadSpec();
    const { body } = operationParamKeys(doc, 'post', '/parse');
    expect(body).toEqual(new Set(['file', 'section', 'title', 'numberingProfileId']));
  });

  it('yields an empty ParamSet for an operation with no params and no body', async () => {
    const doc = await loadSpec();
    const { query, body } = operationParamKeys(doc, 'get', '/health');
    expect(query.size).toBe(0);
    expect(body.size).toBe(0);
  });
});
