import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror clients.test.ts: mock the DatabaseError class the module-under-test sees
// (users.ts imports it from '../index.js') so instanceof checks line up, and mock the pool.
class MockDatabaseError extends Error {
  cause?: unknown;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseError';
    this.cause = options?.cause;
  }
}

vi.mock('../errors.js', () => ({ DatabaseError: MockDatabaseError }));
vi.mock('../index.js', () => ({
  DatabaseError: MockDatabaseError,
  pool: { query: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const NOW = new Date('2026-07-11T00:00:00.000Z');
const userRow = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  label: 'Alice',
  created_at: NOW,
  ...over,
});

describe('resolveOrCreateUserByLabel', () => {
  it('maps the upserted row to a UserSummary', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    const result = await resolveOrCreateUserByLabel('Alice', pool);
    expect(result).toEqual({ id: 'u1', label: 'Alice', createdAt: NOW });
  });

  it('is idempotent: the same label upserts to the same id across two calls', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    const first = await resolveOrCreateUserByLabel('Alice', pool);
    const second = await resolveOrCreateUserByLabel('Alice', pool);
    expect(first.id).toBe(second.id);
  });

  it('upserts via ON CONFLICT DO UPDATE on the label unique constraint', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    await resolveOrCreateUserByLabel('Alice', pool);
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO UPDATE');
  });

  it('throws DatabaseError with the pg error chained as cause on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const pgErr = new Error('db down');
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    const err = await resolveOrCreateUserByLabel('Alice', pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });

  it('throws DatabaseError when the upsert returns no row', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    await expect(resolveOrCreateUserByLabel('Alice', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('listUsers', () => {
  it('maps rows and orders by label, id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { listUsers } = await import('./users.js');
    const result = await listUsers(pool);
    expect(result).toEqual([{ id: 'u1', label: 'Alice', createdAt: NOW }]);
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toContain('ORDER BY label, id');
  });

  it('returns an empty array when the table is empty', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { listUsers } = await import('./users.js');
    expect(await listUsers(pool)).toEqual([]);
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { listUsers } = await import('./users.js');
    await expect(listUsers(pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getUser', () => {
  it('returns the mapped user when found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { getUser } = await import('./users.js');
    expect(await getUser('u1', pool)).toEqual({ id: 'u1', label: 'Alice', createdAt: NOW });
  });

  // Invariant: any syntactically valid but non-existent UUID resolves to null, never a throw —
  // the REST/MCP layers translate this to 404/not-found, not a 500.
  it('returns null for a syntactically valid but non-existent id (never throws not-found)', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getUser } = await import('./users.js');
    expect(await getUser('00000000-0000-0000-0000-000000000000', pool)).toBeNull();
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getUser } = await import('./users.js');
    await expect(getUser('u1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});
