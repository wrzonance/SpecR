import { describe, it, expect, vi, beforeEach } from 'vitest';

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

  it('returns SpecTree when row found', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'abc', section: '27 21 00', title: 'Cabling', source: 'ufgs' }],
    } as never);
    const { findSpecById } = await import('./specs.js');
    const result = await findSpecById('abc');
    expect(result).toEqual({ id: 'abc', section: '27 21 00', title: 'Cabling', parts: [] });
  });

  it('returns null when no row found', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    const { findSpecById } = await import('./specs.js');
    expect(await findSpecById('missing')).toBeNull();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('connection lost'));
    const { findSpecById } = await import('./specs.js');
    await expect(findSpecById('abc')).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('updateSpec', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns SpecSummary when row updated', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'abc', section: '27 21 00', title: 'New Title' }],
    } as never);
    const { updateSpec } = await import('./specs.js');
    const result = await updateSpec('abc', { title: 'New Title' });
    expect(result).toEqual({ specId: 'abc', section: '27 21 00', title: 'New Title' });
  });

  it('returns null when no row updated', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    const { updateSpec } = await import('./specs.js');
    expect(await updateSpec('missing', { title: 'x' })).toBeNull();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('timeout'));
    const { updateSpec } = await import('./specs.js');
    await expect(updateSpec('abc', {})).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('createSpec', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('resolves the default library by source when libraryId is omitted', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: 'lib-ufgs' }] } as never) // library lookup
      .mockResolvedValueOnce({ rows: [{ id: 'spec-1' }] } as never); // insert
    const { createSpec } = await import('./specs.js');
    const id = await createSpec({ section: '09 91 26', title: 'Paint', source: 'ufgs' });
    expect(id).toBe('spec-1');
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['UFGS Reference']);
    expect(vi.mocked(query).mock.calls[1]?.[1]).toEqual(['09 91 26', 'Paint', 'ufgs', 'lib-ufgs']);
  });

  it('uses an explicit libraryId without a lookup query', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: 'spec-2' }] } as never);
    const { createSpec } = await import('./specs.js');
    const id = await createSpec({
      section: '09 91 26',
      title: 'Paint',
      source: 'arcat',
      libraryId: 'lib-explicit',
    });
    expect(id).toBe('spec-2');
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual([
      '09 91 26',
      'Paint',
      'arcat',
      'lib-explicit',
    ]);
  });
});
