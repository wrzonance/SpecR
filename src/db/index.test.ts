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

// Mock pg Pool as a constructable — hoisted before static imports
vi.mock('pg', () => {
  const pool = { query: vi.fn(), end: vi.fn(), on: vi.fn() };
  const Pool = vi.fn(function () {
    return pool;
  });
  return { Pool };
});

import { Pool } from 'pg';
import { DatabaseError, pingDatabase } from './index.js';

function getPool(): { query: ReturnType<typeof vi.fn> } {
  return vi.mocked(Pool).mock.results[0]?.value as { query: ReturnType<typeof vi.fn> };
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
