import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerDocsRoutes } from './docs.js';
import { SCALAR_DIR, SCALAR_STANDALONE } from './docs-assets.js';

const STUB = '/* scalar standalone test stub */ globalThis.Scalar = { createApiReference() {} };';
const assetPath = join(SCALAR_DIR, SCALAR_STANDALONE);

let server: Server;
let baseUrl: string;
let wroteStub = false;

beforeAll(async () => {
  // The /docs/scalar.js route serves the vendored bundle from disk. Use a stub
  // when no real bundle is vendored, so the test needs no network.
  if (!existsSync(assetPath)) {
    mkdirSync(SCALAR_DIR, { recursive: true });
    writeFileSync(assetPath, STUB);
    wroteStub = true;
  }
  const app = express();
  registerDocsRoutes(app);
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
  if (wroteStub) rmSync(assetPath);
});

describe('GET /docs (Scalar reference)', () => {
  it('serves an HTML page that boots Scalar', async () => {
    const res = await fetch(`${baseUrl}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain("createApiReference('#app', { url: '/openapi.yaml' })");
  });

  it('serves the vendored bundle as JavaScript', async () => {
    const res = await fetch(`${baseUrl}/docs/scalar.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toContain('createApiReference');
  });

  it('serves the OpenAPI document', async () => {
    const res = await fetch(`${baseUrl}/openapi.yaml`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('openapi: 3.1');
  });
});
