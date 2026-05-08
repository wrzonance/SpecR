import { describe, it, expect, vi, beforeAll } from 'vitest';

// Provide required env vars before any module evaluation
vi.mock('../lib/env.js', () => ({
  config: {
    PORT: 3000,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
  },
}));

// Mock pg Pool — hoisted before static imports
vi.mock('pg', () => {
  const mockPool = {
    query: vi.fn(),
    end: vi.fn(),
    on: vi.fn(),
  };
  function MockPool() {
    return mockPool;
  }
  MockPool.prototype = mockPool;
  return { Pool: MockPool };
});

import { DatabaseError } from './index.js';

describe('db/index', () => {
  describe('pingDatabase', () => {
    let mockPool: { query: ReturnType<typeof vi.fn> };

    beforeAll(async () => {
      const { Pool } = await import('pg');
      mockPool = new Pool() as unknown as { query: ReturnType<typeof vi.fn> };
    });

    it('calls pool.query with SELECT 1', async () => {
      const { pingDatabase } = await import('./index.js');
      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      await pingDatabase(mockPool as never);
      expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws DatabaseError when query fails', async () => {
      const { pingDatabase } = await import('./index.js');
      mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(pingDatabase(mockPool as never)).rejects.toThrow(DatabaseError);
    });

    it('DatabaseError carries original error as cause', async () => {
      const { pingDatabase } = await import('./index.js');
      const originalError = new Error('ECONNREFUSED');
      mockPool.query.mockRejectedValueOnce(originalError);

      try {
        await pingDatabase(mockPool as never);
      } catch (err) {
        expect((err as DatabaseError).cause).toBe(originalError);
      }
    });
  });
});
