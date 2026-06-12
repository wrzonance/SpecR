import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index.js', () => ({
  DatabaseError: class DatabaseError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
    }
  },
  pool: { query: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const LIB_ROW = {
  id: 'lib-1',
  tier: 'company',
  name: 'Default Company Master',
  owner: null,
  parent_library_id: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
};

const LIB_MAPPED = {
  id: 'lib-1',
  tier: 'company',
  name: 'Default Company Master',
  owner: null,
  parentLibraryId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('createLibrary', () => {
  it('returns the mapped Library on success', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [LIB_ROW], rowCount: 1 } as never);
    const { createLibrary } = await import('./libraries.js');
    const result = await createLibrary({ tier: 'company', name: 'Default Company Master' });
    expect(result).toEqual(LIB_MAPPED);
  });

  it('passes owner and parentLibraryId through to the insert', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [LIB_ROW], rowCount: 1 } as never);
    const { createLibrary } = await import('./libraries.js');
    await createLibrary({
      tier: 'client',
      name: 'Acme',
      owner: 'Acme Corp',
      parentLibraryId: 'lib-1',
    });
    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual([
      'client',
      'Acme',
      'Acme Corp',
      'lib-1',
    ]);
  });

  it('wraps insert failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { createLibrary } = await import('./libraries.js');
    await expect(createLibrary({ tier: 'company', name: 'x' })).rejects.toBeInstanceOf(
      DatabaseError
    );
  });
});

describe('findLibraryById', () => {
  it('returns null when not found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { findLibraryById } = await import('./libraries.js');
    expect(await findLibraryById('missing')).toBeNull();
  });

  it('returns the mapped Library when found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [LIB_ROW], rowCount: 1 } as never);
    const { findLibraryById } = await import('./libraries.js');
    expect(await findLibraryById('lib-1')).toEqual(LIB_MAPPED);
  });

  it('wraps query failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { findLibraryById } = await import('./libraries.js');
    await expect(findLibraryById('lib-1')).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('findLibraryByName', () => {
  it('returns the mapped Library when found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [LIB_ROW], rowCount: 1 } as never);
    const { findLibraryByName } = await import('./libraries.js');
    expect(await findLibraryByName('Default Company Master')).toEqual(LIB_MAPPED);
  });

  it('returns null when not found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { findLibraryByName } = await import('./libraries.js');
    expect(await findLibraryByName('missing')).toBeNull();
  });

  it('wraps query failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { findLibraryByName } = await import('./libraries.js');
    await expect(findLibraryByName('x')).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('listLibraries', () => {
  it('returns all mapped rows', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [LIB_ROW], rowCount: 1 } as never);
    const { listLibraries } = await import('./libraries.js');
    expect(await listLibraries()).toEqual([LIB_MAPPED]);
  });

  it('wraps query failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { listLibraries } = await import('./libraries.js');
    await expect(listLibraries()).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('resolveDefaultLibraryId', () => {
  it('resolves source=ufgs to the UFGS Reference library', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'lib-ufgs' }],
      rowCount: 1,
    } as never);
    const { resolveDefaultLibraryId } = await import('./libraries.js');
    expect(await resolveDefaultLibraryId('ufgs')).toBe('lib-ufgs');
    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual(['UFGS Reference']);
  });

  it('resolves non-ufgs sources to the Default Company Master library', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ id: 'lib-co' }], rowCount: 1 } as never);
    const { resolveDefaultLibraryId } = await import('./libraries.js');
    expect(await resolveDefaultLibraryId('arcat')).toBe('lib-co');
    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual(['Default Company Master']);
  });

  it('throws DatabaseError when the built-in library is missing', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { resolveDefaultLibraryId } = await import('./libraries.js');
    await expect(resolveDefaultLibraryId('arcat')).rejects.toBeInstanceOf(DatabaseError);
  });
});
