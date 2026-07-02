import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'node:net';

// Stub env before any module evaluation — env.ts calls process.exit(1) without DATABASE_URL.
// The rate-limit fields are what's under test: the limiter reads them LIVE (per-request
// closures), so individual tests mutate config.* to prove config-driven behaviour and that
// a runtime change is honoured without reconstructing the middleware.
vi.mock('../lib/env.js', () => ({
  config: {
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MCP_ALLOWED_TIERS: 'read,write',
    DISABLE_RATE_LIMIT: false,
    RATE_LIMIT_UPLOAD_MAX: 10,
    RATE_LIMIT_MCP_MAX: 20,
    RATE_LIMIT_WINDOW_MS: 60000,
  },
}));

// Stub pg Pool — rate-limit test does not hit the DB (tools/list is handled by the MCP SDK).
vi.mock('pg', () => {
  const pool = { query: vi.fn(), end: vi.fn(), on: vi.fn() };
  const Pool = vi.fn(function () {
    return pool;
  });
  return { Pool };
});

import express from 'express';
import { registerMcpRoutes } from './server.js';
import { config } from '../lib/env.js';

const REQUEST_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const REQUEST_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

let server: Server | undefined;

// Narrow Server.address() (string | AddressInfo | null) without a type assertion —
// app.listen(0) yields an AddressInfo for TCP, but the guard keeps us honest per the
// project's no-assertions rule.
function isAddressInfo(addr: string | AddressInfo | null): addr is AddressInfo {
  return addr !== null && typeof addr === 'object';
}

async function startServer(): Promise<string> {
  const app = express();
  registerMcpRoutes(app);
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

async function postMcp(baseUrl: string): Promise<number> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: REQUEST_HEADERS,
    body: REQUEST_BODY,
  });
  return res.status;
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) {
    await new Promise<void>((resolve, reject) => {
      running.close((err) => (err != null ? reject(err) : resolve()));
    });
  }
  // Undo any per-test mutation of the shared mocked config.
  config.DISABLE_RATE_LIMIT = false;
  config.RATE_LIMIT_MCP_MAX = 20;
});

describe('POST /mcp rate limiting — config-driven', () => {
  it('returns 429 after the configured RATE_LIMIT_MCP_MAX (not a hardcoded 20)', async () => {
    config.RATE_LIMIT_MCP_MAX = 3;
    const baseUrl = await startServer();

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push(await postMcp(baseUrl));

    // First 3 succeed, 4th is blocked — proves the ceiling comes from config, not a literal.
    expect(statuses.slice(0, 3).every((s) => s >= 200 && s < 300)).toBe(true);
    expect(statuses[3]).toBe(429);
  });

  it('DISABLE_RATE_LIMIT=true bypasses the limiter entirely', async () => {
    config.DISABLE_RATE_LIMIT = true;
    config.RATE_LIMIT_MCP_MAX = 3;
    const baseUrl = await startServer();

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await postMcp(baseUrl));

    expect(statuses.every((s) => s >= 200 && s < 300)).toBe(true);
    expect(statuses).not.toContain(429);
  });

  it('honours a runtime change to config without reconstructing the limiter (live read)', async () => {
    config.RATE_LIMIT_MCP_MAX = 3;
    const baseUrl = await startServer();

    const before: number[] = [];
    for (let i = 0; i < 4; i++) before.push(await postMcp(baseUrl));
    expect(before[3]).toBe(429); // limiter is active and has tripped

    // Flip the flag at runtime — the SAME limiter instance must now skip on the next request.
    config.DISABLE_RATE_LIMIT = true;
    const after = await postMcp(baseUrl);
    expect(after).not.toBe(429);
    expect(after).toBeGreaterThanOrEqual(200);
    expect(after).toBeLessThan(300);
  });
});
