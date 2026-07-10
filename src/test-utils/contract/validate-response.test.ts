import { describe, it, expect } from 'vitest';
import {
  assertResponse,
  specOperationManifest,
  successJsonOps,
  loadSpec,
} from './validate-response.js';

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
