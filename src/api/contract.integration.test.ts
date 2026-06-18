import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import {
  assertResponse,
  expressRouteManifest,
  specOperationManifest,
  successJsonOps,
  loadSpec,
} from '../test-utils/contract/validate-response.js';

// MCP is registered separately (not on `router`); exclude defensively.
const EXCLUDE = new Set(['post /mcp', 'get /mcp', 'delete /mcp']);

// Response bodies asserted in this file.
const RESPONSE_COVERED = new Set(['get /health', 'get /conventions', 'get /templates']);

// Documented JSON ops not yet response-verified (burned down in PR2…N).
const RESPONSE_ALLOWLIST = new Set([
  'delete /packages/{}',
  'delete /projects/{}/specs/{}',
  'delete /specs/{}/lock',
  'delete /specs/{}/style-source',
  'get /libraries/{}/conventions',
  'get /libraries/{}/divisions/{}/general-spec',
  'get /parse/jobs/{}',
  'get /projects/{}',
  'get /projects/{}/divisions/{}/general-spec',
  'get /projects/{}/packages',
  'get /projects/{}/references/broken',
  'get /projects/{}/references/inbound',
  'get /projects/{}/specs/{}/references',
  'get /revisions/{}',
  'get /specs/{}',
  'get /specs/{}/lineage',
  'get /specs/{}/lock',
  'get /templates/{}',
  'patch /specs/{}',
  'patch /specs/{}/paragraphs/{}',
  'patch /templates/{}',
  'post /libraries/{}/conventions/clone',
  'post /packages/{}/revisions',
  'post /parse',
  'post /projects',
  'post /projects/{}/packages',
  'post /projects/{}/specs',
  'post /specs/{}/diff',
  'post /specs/{}/merge',
  'post /specs/{}/style-source',
  'post /templates',
  'post /templates/import',
  'post /templates/{}/rules',
  'put /libraries/{}/conventions',
  'put /libraries/{}/divisions/{}/general-spec',
  'put /packages/{}/specs',
  'put /projects/{}/divisions/{}/general-spec',
  'put /specs/{}/lock',
]);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('openapi structural coverage (route <-> spec, both directions)', () => {
  it('every Express route is documented and every documented op is implemented', async () => {
    const doc = await loadSpec();
    const exp = new Set(expressRouteManifest(router));
    const spec = new Set(specOperationManifest(doc));
    const undocumented = [...exp]
      .filter((o) => !spec.has(o) && !EXCLUDE.has(o))
      .sort((a, b) => a.localeCompare(b));
    const unimplemented = [...spec]
      .filter((o) => !exp.has(o) && !EXCLUDE.has(o))
      .sort((a, b) => a.localeCompare(b));
    expect(undocumented, 'Express routes missing from openapi.yaml').toEqual([]);
    expect(unimplemented, 'openapi.yaml operations with no Express route').toEqual([]);
  });

  it('every success-JSON operation is response-covered or explicitly allowlisted', async () => {
    const doc = await loadSpec();
    const uncovered = successJsonOps(doc).filter(
      (o) => !RESPONSE_COVERED.has(o) && !RESPONSE_ALLOWLIST.has(o) && !EXCLUDE.has(o)
    );
    expect(uncovered, 'JSON ops needing a response assertion or allowlist entry').toEqual([]);
  });
});

describe('response contract (covered endpoints)', () => {
  it('GET /health matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/health', 200, await res.json());
  });

  it('GET /conventions matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/conventions`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/conventions', 200, await res.json());
  });

  it('GET /templates matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/templates`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/templates', 200, await res.json());
  });
});
