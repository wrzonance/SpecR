import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import { handleResolveUser, handleListUsers, handleGetUser } from './users-handlers.js';
import type { ToolResult } from './handlers.js';

const MISSING = '00000000-0000-4000-8000-000000000099';

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

let seq = 0;
const uniq = (part: string): string => {
  seq += 1;
  return `users-mcp-test-${part}-${seq}-${randomUUID().slice(0, 8)}`;
};

afterAll(async () => {
  await pool.query(`DELETE FROM users WHERE label LIKE 'users-mcp-test-%'`);
});

describe('users MCP tools', () => {
  it('resolve_user creates a new user on first call', async () => {
    const label = uniq('create');
    const res = await handleResolveUser({ label });
    expect(isToolError(res)).toBe(false);
    const user = parse<{ id: string; label: string; createdAt: string }>(res);
    expect(user.label).toBe(label);
    expect(typeof user.id).toBe('string');
  });

  it('resolve_user is idempotent — same label resolves to the same id', async () => {
    const label = uniq('idempotent');
    const first = parse<{ id: string }>(await handleResolveUser({ label }));
    const second = parse<{ id: string }>(await handleResolveUser({ label }));
    expect(second.id).toBe(first.id);
  });

  it('resolve_user rejects an empty or whitespace-only label', async () => {
    expect(isToolError(await handleResolveUser({ label: '' }))).toBe(true);
    expect(isToolError(await handleResolveUser({ label: '   ' }))).toBe(true);
  });

  it('resolve_user rejects a label over 200 characters', async () => {
    const res = await handleResolveUser({ label: 'x'.repeat(201) });
    expect(isToolError(res)).toBe(true);
  });

  it('resolve_user rejects malformed input (missing label)', async () => {
    expect(isToolError(await handleResolveUser({}))).toBe(true);
  });

  it('list_users includes a resolved user', async () => {
    const label = uniq('list');
    await handleResolveUser({ label });
    const rows = parse<{ label: string }[]>(await handleListUsers());
    expect(rows.map((u) => u.label)).toContain(label);
  });

  it('get_user returns the user by id; bad/unknown id is an error', async () => {
    const label = uniq('get');
    const created = parse<{ id: string }>(await handleResolveUser({ label }));

    const detail = parse<{ id: string; label: string }>(
      await handleGetUser({ userId: created.id })
    );
    expect(detail.id).toBe(created.id);
    expect(detail.label).toBe(label);

    expect(isToolError(await handleGetUser({ userId: 'not-a-uuid' }))).toBe(true);
    expect(isToolError(await handleGetUser({ userId: MISSING }))).toBe(true);
  });
});
