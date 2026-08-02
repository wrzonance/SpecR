import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror clients.test.ts / checkpoints.test.ts: mock the DatabaseError class the
// module-under-test sees (templates.ts imports it from '../index.js') so instanceof
// checks line up, and mock the pool + countSpecsUsingTemplate (also re-exported
// from '../index.js', per src/db/index.ts's barrel).
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
  pool: { query: vi.fn(), connect: vi.fn() },
  countSpecsUsingTemplate: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('deleteTemplate', () => {
  it('returns deleted:true when the pre-check finds no references and the delete succeeds', async () => {
    const { pool, countSpecsUsingTemplate } = await import('../index.js');
    vi.mocked(countSpecsUsingTemplate).mockResolvedValueOnce(0);
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 1 } as never);
    const { deleteTemplate } = await import('./templates.js');

    await expect(deleteTemplate('t1')).resolves.toEqual({ deleted: true });
  });

  it('returns reason "not_found" when the pre-check passes but no row matches the delete', async () => {
    const { pool, countSpecsUsingTemplate } = await import('../index.js');
    vi.mocked(countSpecsUsingTemplate).mockResolvedValueOnce(0);
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 0 } as never);
    const { deleteTemplate } = await import('./templates.js');

    await expect(deleteTemplate('missing')).resolves.toEqual({
      deleted: false,
      reason: 'not_found',
    });
  });

  it('returns reason "in_use" via the pre-check count, without ever issuing the DELETE', async () => {
    const { pool, countSpecsUsingTemplate } = await import('../index.js');
    vi.mocked(countSpecsUsingTemplate).mockResolvedValueOnce(3);
    const { deleteTemplate } = await import('./templates.js');

    await expect(deleteTemplate('t1')).resolves.toEqual({
      deleted: false,
      reason: 'in_use',
      inUseBy: 3,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Race-window backstop (see deleteTemplate's own comment): a spec gets assigned
  // between the pre-check and the DELETE, so Postgres rejects the DELETE itself.
  // Postgres <=16 reports this as the generic foreign_key_violation (23503);
  // Postgres 18 disambiguates it as restrict_violation (23001) — the backstop
  // must recognise BOTH so the behavior doesn't regress under Postgres 18.
  it.each(['23503', '23001'])(
    'falls back to reason "in_use" when the DELETE itself is rejected by the RESTRICT FK (%s)',
    async (code) => {
      const { pool, countSpecsUsingTemplate } = await import('../index.js');
      vi.mocked(countSpecsUsingTemplate)
        .mockResolvedValueOnce(0) // pre-check: clear
        .mockResolvedValueOnce(2); // re-count after the race is detected
      const pgErr = Object.assign(new Error('restrict violation'), { code });
      vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
      const { deleteTemplate } = await import('./templates.js');

      await expect(deleteTemplate('t1')).resolves.toEqual({
        deleted: false,
        reason: 'in_use',
        inUseBy: 2,
      });
    }
  );

  it('rethrows a DatabaseError for an unrelated pg error code', async () => {
    const { pool, countSpecsUsingTemplate, DatabaseError } = await import('../index.js');
    vi.mocked(countSpecsUsingTemplate).mockResolvedValueOnce(0);
    const pgErr = Object.assign(new Error('db down'), { code: '53300' });
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { deleteTemplate } = await import('./templates.js');

    const err = await deleteTemplate('t1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});
