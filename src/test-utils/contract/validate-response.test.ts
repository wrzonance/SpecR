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
