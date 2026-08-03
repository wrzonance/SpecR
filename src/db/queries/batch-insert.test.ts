import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror checkpoints.test.ts: mock the DatabaseError class the module-under-test
// sees (batch-insert.ts imports it from '../index.js') so instanceof checks and
// message/cause assertions line up.
class MockDatabaseError extends Error {
  cause?: unknown;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseError';
    this.cause = options?.cause;
  }
}

vi.mock('../index.js', () => ({
  DatabaseError: MockDatabaseError,
  pool: { query: vi.fn(), connect: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('chunkRows', () => {
  it('flattens back to the original rows for varied sizes and chunk sizes', async () => {
    const { chunkRows } = await import('./batch-insert.js');
    const cases: Array<{ rows: number[]; chunkSize: number }> = [
      { rows: [], chunkSize: 3 },
      { rows: [1], chunkSize: 1 },
      { rows: [1, 2, 3, 4, 5], chunkSize: 2 },
      { rows: [1, 2, 3], chunkSize: 100 },
      { rows: [1, 2, 3, 4, 5, 6], chunkSize: 3 },
    ];
    for (const { rows, chunkSize } of cases) {
      expect(chunkRows(rows, chunkSize).flat()).toEqual(rows);
    }
  });

  it('never produces a chunk larger than chunkSize', async () => {
    const { chunkRows } = await import('./batch-insert.js');
    const rows = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkRows(rows, 3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3);
    }
  });

  it('throws RangeError for a non-positive chunkSize', async () => {
    const { chunkRows } = await import('./batch-insert.js');
    expect(() => chunkRows([1, 2, 3], 0)).toThrow(RangeError);
    expect(() => chunkRows([1, 2, 3], -1)).toThrow(RangeError);
  });
});

describe('maxRowsPerStatement', () => {
  it('keeps rows * columnsPerRow under the param limit for varied inputs', async () => {
    const { maxRowsPerStatement, POSTGRES_MAX_BIND_PARAMS } = await import('./batch-insert.js');
    const columnCounts = [1, 2, 5, 7, 12, 65535, 100000];
    for (const columnsPerRow of columnCounts) {
      const rows = maxRowsPerStatement(columnsPerRow);
      expect(rows * columnsPerRow).toBeLessThanOrEqual(POSTGRES_MAX_BIND_PARAMS);
    }
  });

  it('respects a custom paramLimit override', async () => {
    const { maxRowsPerStatement } = await import('./batch-insert.js');
    expect(maxRowsPerStatement(4, 10)).toBe(2); // floor(10/4) = 2
    expect(2 * 4).toBeLessThanOrEqual(10);
  });

  it('throws RangeError for a non-positive columnsPerRow', async () => {
    const { maxRowsPerStatement } = await import('./batch-insert.js');
    expect(() => maxRowsPerStatement(0)).toThrow(RangeError);
    expect(() => maxRowsPerStatement(-3)).toThrow(RangeError);
  });
});

describe('buildColumnListSql / buildValuesSql', () => {
  it('builds a comma-joined column list', async () => {
    const { buildColumnListSql } = await import('./batch-insert.js');
    expect(buildColumnListSql([{ name: 'a' }, { name: 'b' }, { name: 'c' }])).toBe('a, b, c');
  });

  it('numbers placeholders row-major and applies casts per column', async () => {
    const { buildValuesSql } = await import('./batch-insert.js');
    const columns = [{ name: 'id' }, { name: 'meta', cast: 'jsonb' }];
    expect(buildValuesSql(columns, 2)).toBe('($1, $2::jsonb), ($3, $4::jsonb)');
  });

  it('produces no groups for a zero row count', async () => {
    const { buildValuesSql } = await import('./batch-insert.js');
    expect(buildValuesSql([{ name: 'a' }], 0)).toBe('');
  });
});

describe('formatIdsPreview', () => {
  it('shows all ids when under the max', async () => {
    const { formatIdsPreview } = await import('./batch-insert.js');
    expect(formatIdsPreview(['a', 'b'])).toBe('a, b');
  });

  it('truncates with a remaining-count suffix beyond the max', async () => {
    const { formatIdsPreview } = await import('./batch-insert.js');
    expect(formatIdsPreview(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 3)).toBe('a, b, c, +4 more');
  });
});

describe('insertRowsInChunks', () => {
  it('is a no-op for an empty rows array', async () => {
    const query = vi.fn();
    const { insertRowsInChunks } = await import('./batch-insert.js');
    await insertRowsInChunks({
      db: { query },
      table: 't',
      columns: [{ name: 'id' }],
      rows: [] as string[],
      toParams: (row: string) => [row],
      idOf: (row: string) => row,
      buildErrorMessage: () => 'unreachable',
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('issues one INSERT per chunk, fully materialized before the query runs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const { insertRowsInChunks } = await import('./batch-insert.js');
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5'];
    await insertRowsInChunks({
      db: { query },
      table: 'widgets',
      columns: [{ name: 'id' }],
      rows,
      toParams: (row: string) => [row],
      idOf: (row: string) => row,
      buildErrorMessage: () => 'unreachable',
      paramLimit: 2, // 1 column/row -> 2 rows/chunk -> 3 chunks (2,2,1)
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]).toEqual([
      'INSERT INTO widgets (id) VALUES ($1), ($2)',
      ['r1', 'r2'],
    ]);
    expect(query.mock.calls[1]).toEqual([
      'INSERT INTO widgets (id) VALUES ($1), ($2)',
      ['r3', 'r4'],
    ]);
    expect(query.mock.calls[2]).toEqual(['INSERT INTO widgets (id) VALUES ($1)', ['r5']]);
  });

  it('is fail-fast: aborts remaining chunks on the first rejection', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockResolvedValueOnce({ rows: [] });
    const { insertRowsInChunks } = await import('./batch-insert.js');
    const rows = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];

    await expect(
      insertRowsInChunks({
        db: { query },
        table: 'widgets',
        columns: [{ name: 'id' }],
        rows,
        toParams: (row: string) => [row],
        idOf: (row: string) => row,
        buildErrorMessage: (ctx) => `failed chunk ${ctx.chunkIndex + 1}/${ctx.totalChunks}`,
        paramLimit: 2,
      })
    ).rejects.toThrow('failed chunk 2/3');

    // Only the first two chunks were attempted — the third chunk never ran.
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('wraps the failure as a DatabaseError carrying the original cause', async () => {
    const originalError = new Error('constraint violation');
    const query = vi.fn().mockRejectedValue(originalError);
    const { insertRowsInChunks } = await import('./batch-insert.js');

    let caught: unknown;
    try {
      await insertRowsInChunks({
        db: { query },
        table: 'widgets',
        columns: [{ name: 'id' }],
        rows: ['r1'],
        toParams: (row: string) => [row],
        idOf: (row: string) => row,
        buildErrorMessage: () => 'insert failed',
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MockDatabaseError);
    expect((caught as MockDatabaseError).message).toBe('insert failed');
    expect((caught as MockDatabaseError).cause).toBe(originalError);
  });

  it('surfaces exactly which rows failed via the ChunkFailureContext ids', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('boom'));
    const { insertRowsInChunks, formatIdsPreview } = await import('./batch-insert.js');
    const rows = ['a', 'b', 'c', 'd'];
    let capturedIds: readonly string[] | undefined;

    await expect(
      insertRowsInChunks({
        db: { query },
        table: 'widgets',
        columns: [{ name: 'id' }],
        rows,
        toParams: (row: string) => [row],
        idOf: (row: string) => row,
        buildErrorMessage: (ctx) => {
          capturedIds = ctx.ids;
          return `failed rows: ${formatIdsPreview(ctx.ids)}`;
        },
        paramLimit: 2, // chunk 1: [a,b], chunk 2 (fails): [c,d]
      })
    ).rejects.toThrow('failed rows: c, d');

    expect(capturedIds).toEqual(['c', 'd']);
  });
});
