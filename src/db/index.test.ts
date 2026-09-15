import { describe, it, expect, vi } from 'vitest';

// Provide required env vars before any module evaluation
vi.mock('../lib/env.js', () => ({
  config: {
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
  },
}));

// The mocked Pool instance is held in vi.hoisted state rather than read back
// from `vi.mocked(Pool).mock.results`: Vitest 5 clears every mock's recorded
// calls/results before each test (`clearMocks` now defaults to true), and the
// Pool constructor only runs once, at module load — so its result would be
// gone by the time the first test looked for it.
const { pool } = vi.hoisted(() => ({
  pool: { query: vi.fn(), end: vi.fn(), on: vi.fn() },
}));

// Mock pg Pool as a constructable — hoisted before static imports
vi.mock('pg', () => {
  const Pool = vi.fn(function () {
    return pool;
  });
  return { Pool };
});

import { DatabaseError, pingDatabase } from './index.js';

function getPool(): { query: ReturnType<typeof vi.fn> } {
  return pool;
}

describe('db/index', () => {
  describe('pingDatabase', () => {
    it('calls pool.query with SELECT 1', async () => {
      const pool = getPool();
      pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      await pingDatabase(pool as never);
      expect(pool.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws DatabaseError when query fails', async () => {
      const pool = getPool();
      pool.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(pingDatabase(pool as never)).rejects.toThrow(DatabaseError);
    });

    it('DatabaseError carries original error as cause', async () => {
      const pool = getPool();
      const originalError = new Error('ECONNREFUSED');
      pool.query.mockRejectedValueOnce(originalError);

      try {
        await pingDatabase(pool as never);
      } catch (err) {
        expect((err as DatabaseError).cause).toBe(originalError);
      }
    });
  });
});
