import { describe, it, expect, vi } from 'vitest';
import { DatabaseError } from './index.js';

// Mock pg Pool before importing db module
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

describe('db/index', () => {
  describe('pingDatabase', () => {
    it('calls pool.query with SELECT 1', async () => {
      const { Pool } = await import('pg');
      const { pingDatabase } = await import('./index.js');
      const mockPool = new Pool() as unknown as { query: ReturnType<typeof vi.fn> };
      mockPool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

      await pingDatabase(mockPool as never);
      expect(mockPool.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws DatabaseError when query fails', async () => {
      const { Pool } = await import('pg');
      const { pingDatabase } = await import('./index.js');
      const mockPool = new Pool() as unknown as { query: ReturnType<typeof vi.fn> };
      mockPool.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(pingDatabase(mockPool as never)).rejects.toThrow(DatabaseError);
    });

    it('DatabaseError carries original error as cause', async () => {
      const { Pool } = await import('pg');
      const { pingDatabase } = await import('./index.js');
      const mockPool = new Pool() as unknown as { query: ReturnType<typeof vi.fn> };
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
