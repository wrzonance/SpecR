import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { deleteCapturedFixtures } from './integration-fixture-cleanup.js';

function fakePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { pool: { query } as unknown as Pool, query };
}

describe('deleteCapturedFixtures', () => {
  it('empty-array no-op: touches zero DELETE statements when every field is an empty array', async () => {
    const { pool, query } = fakePool();
    await deleteCapturedFixtures(pool, { specIds: [], projectIds: [], libraryIds: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it('undefined-fields no-op: touches zero DELETE statements when nothing is captured', async () => {
    const { pool, query } = fakePool();
    await deleteCapturedFixtures(pool, {});
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes in FK-safe order: specs, then projects, then libraries', async () => {
    const { pool, query } = fakePool();
    await deleteCapturedFixtures(pool, {
      specIds: ['spec-1'],
      projectIds: ['project-1'],
      libraryIds: ['library-1'],
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]?.[0]).toMatch(/DELETE FROM specs/);
    expect(query.mock.calls[0]?.[1]).toEqual([['spec-1']]);
    expect(query.mock.calls[1]?.[0]).toMatch(/DELETE FROM projects/);
    expect(query.mock.calls[1]?.[1]).toEqual([['project-1']]);
    expect(query.mock.calls[2]?.[0]).toMatch(/DELETE FROM libraries/);
    expect(query.mock.calls[2]?.[1]).toEqual([['library-1']]);
  });

  it('deletes only the field(s) actually captured', async () => {
    const { pool, query } = fakePool();
    await deleteCapturedFixtures(pool, { specIds: ['spec-1'] });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toMatch(/DELETE FROM specs/);
  });

  it('wraps a query failure in a DatabaseError with cause chained', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('pg exploded')) } as unknown as Pool;

    await expect(deleteCapturedFixtures(pool, { specIds: ['spec-1'] })).rejects.toThrow(
      /failed to delete captured integration-test fixtures/
    );
  });
});
