import { describe, it, expect, vi, beforeEach } from 'vitest';

type MockPool = { query: ReturnType<typeof vi.fn> };
type MockDb = { pool: MockPool; DatabaseError: typeof Error };

vi.mock('../index.js', () => {
  const query = vi.fn();
  return {
    pool: { query },
    DatabaseError: class DatabaseError extends Error {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseError';
      }
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('findSpecById', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns CsiTree when row found', async () => {
    const { pool } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'abc', section: '27 21 00', title: 'Cabling', source: 'ufgs' }],
    });
    const { findSpecById } = await import('./specs.js');
    const result = await findSpecById('abc');
    expect(result).toEqual({ id: 'abc', section: '27 21 00', title: 'Cabling', parts: [] });
  });

  it('returns null when no row found', async () => {
    const { pool } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockResolvedValueOnce({ rows: [] });
    const { findSpecById } = await import('./specs.js');
    expect(await findSpecById('missing')).toBeNull();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockRejectedValueOnce(new Error('connection lost'));
    const { findSpecById } = await import('./specs.js');
    await expect(findSpecById('abc')).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('updateSpec', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns SpecSummary when row updated', async () => {
    const { pool } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 'abc', section: '27 21 00', title: 'New Title' }],
    });
    const { updateSpec } = await import('./specs.js');
    const result = await updateSpec('abc', { title: 'New Title' });
    expect(result).toEqual({ specId: 'abc', section: '27 21 00', title: 'New Title' });
  });

  it('returns null when no row updated', async () => {
    const { pool } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockResolvedValueOnce({ rows: [] });
    const { updateSpec } = await import('./specs.js');
    expect(await updateSpec('missing', { title: 'x' })).toBeNull();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = (await import('../index.js')) as unknown as MockDb;
    pool.query.mockRejectedValueOnce(new Error('timeout'));
    const { updateSpec } = await import('./specs.js');
    await expect(updateSpec('abc', {})).rejects.toBeInstanceOf(DatabaseError);
  });
});
