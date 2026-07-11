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

  // Real idempotency/race-freeness (does a second call for the same label actually resolve
  // to the same row, incl. under concurrency) can only be pinned against a real ON CONFLICT
  // constraint — see the integration tests 'resolveOrCreateUserByLabel is a pure idempotent
  // upsert...' and '...concurrent calls for the same label race-free onto a single row' in
  // users.integration.test.ts. A mock-based unit test that queues two byte-identical canned
  // responses can't fail regardless of what the SQL says, so it belongs at the query-shape
  // level instead: assert the statement issued is actually the race-free upsert, not a
  // regression to check-then-insert or to ON CONFLICT DO NOTHING (which would return the
  // pre-existing row unmodified on a conflict rather than upserting it, and — for a fresh
  // label — return no row at all, which the "no row returned" branch below already guards).
  it('issues a single ON CONFLICT ... DO UPDATE statement, not check-then-insert or DO NOTHING', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [userRow()], rowCount: 1 } as never);
    const { resolveOrCreateUserByLabel } = await import('./users.js');
    await resolveOrCreateUserByLabel('Alice', pool);

    const calls = vi.mocked(pool.query).mock.calls;
    // A single round trip is what makes the upsert race-free under concurrency: a
    // check-then-insert (SELECT, then conditional INSERT) would need two.
    expect(calls.length).toBe(1);
    const sql = calls[0]?.[0];
    expect(sql).toContain('ON CONFLICT (label) DO UPDATE');
    expect(sql).not.toContain('DO NOTHING');
    expect(calls[0]?.[1]).toEqual(['Alice']);
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
