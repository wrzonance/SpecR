import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Stub env before any module evaluation — env.ts calls process.exit(1) without DATABASE_URL
vi.mock('../lib/env.js', () => ({
  config: {
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
  },
}));

// Stub pg Pool — rate-limit test does not hit the DB (tools/list is handled by MCP SDK)
vi.mock('pg', () => {
  const pool = { query: vi.fn(), end: vi.fn(), on: vi.fn() };
  const Pool = vi.fn(function () {
    return pool;
  });
  return { Pool };
});

import express from 'express';
import type { Server } from 'http';
import { registerMcpRoutes } from './server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerMcpRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err != null ? reject(err) : resolve()));
    })
);

describe('POST /mcp rate limiting', () => {
  it('returns 429 after 20 requests within 1 minute', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };

    const responses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers, body });
      responses.push(res.status);
    }

    // First 20 must be successful (2xx)
    expect(responses.slice(0, 20).every((s) => s >= 200 && s < 300)).toBe(true);
    // 21st must be 429
    expect(responses[20]).toBe(429);
  });
});
