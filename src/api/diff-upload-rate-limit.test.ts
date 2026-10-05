import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

// #692 regression, observed symptom: POST /specs/:id/diff accepted an unbounded
// stream of uploads from one client while the other upload routes answered 429.
// This drives the real router over HTTP. The upload limiter skips itself when
// NODE_ENV === 'test' and reads its ceiling LIVE per request (src/lib/env.ts),
// so the env stub below declares a non-test environment and the test lowers the
// ceiling to one request. The sibling router-upload-rate-limit.test.ts pins the
// broader invariant (every upload route has the limiter) structurally.
vi.mock('../lib/env.js', () => ({
  config: {
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    MCP_ALLOWED_TIERS: 'read,write',
    DISABLE_RATE_LIMIT: false,
    RATE_LIMIT_UPLOAD_MAX: 1,
    RATE_LIMIT_MCP_MAX: 20,
    RATE_LIMIT_WINDOW_MS: 60000,
    HISTORY_SESSION_WINDOW_MS: 1800000,
  },
}));

// No request below reaches the database: the limiter answers first, and an
// upload-less POST is rejected by the handler before any query.
vi.mock('pg', () => {
  const pool = { query: vi.fn(), end: vi.fn(), on: vi.fn() };
  const Pool = vi.fn(function () {
    return pool;
  });
  return { Pool };
});

import express from 'express';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

const SPEC_ID = '00000000-0000-0000-0000-000000000000';

let server: Server | undefined;

function isAddressInfo(addr: string | AddressInfo | null): addr is AddressInfo {
  return addr !== null && typeof addr === 'object';
}

async function startServer(): Promise<string> {
  const app = express();
  app.disable('x-powered-by');
  app.use(router);
  app.use(errorHandler);
  const started = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  server = started;
  const addr = started.address();
  if (!isAddressInfo(addr)) {
    throw new Error('expected AddressInfo from a listening TCP server');
  }
  return `http://127.0.0.1:${addr.port}`;
}

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('POST /specs/:id/diff is rate limited (#692)', () => {
  it('diff upload: the request over the per-window ceiling is answered 429, not parsed', async () => {
    const baseUrl = await startServer();
    const post = (): Promise<Response> =>
      fetch(`${baseUrl}/specs/${SPEC_ID}/diff`, { method: 'POST' });

    const first = await post();
    expect(first.status, 'the first request must reach the handler').toBe(400);

    const second = await post();
    expect(second.status).toBe(429);
    expect(await second.json()).toEqual({
      success: false,
      error: 'too many requests — please wait before uploading again',
    });
  });
});
