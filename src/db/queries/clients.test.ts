import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror projects.test.ts: mock the DatabaseError class the module-under-test sees
// (clients.ts imports it from '../index.js') so instanceof checks line up, and mock
// the pool. clients.ts type-imports projects.ts only (erased), so no projects mock is needed.
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
  pool: { query: vi.fn() },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const NOW = new Date('2026-07-07T00:00:00.000Z');
const clientRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Acme',
  library_id: null,
  section_number_format: 'canonical',
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

describe('createClient', () => {
  it('inserts and returns the mapped summary', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [clientRow()], rowCount: 1 } as never);
    const { createClient } = await import('./clients.js');
    const result = await createClient({ name: 'Acme' }, pool);
    expect(result).toEqual({
      id: 'c1',
      name: 'Acme',
      libraryId: null,
      sectionNumberFormat: 'canonical',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('persists a supplied firm section-number default', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [clientRow({ section_number_format: 'dots' })],
      rowCount: 1,
    } as never);
    const { createClient } = await import('./clients.js');
    const result = await createClient({ name: 'Acme', sectionNumberFormat: 'dots' }, pool);
    expect(result.sectionNumberFormat).toBe('dots');
    expect(vi.mocked(pool.query).mock.calls[0]?.[1]).toEqual(['Acme', null, 'dots']);
  });

  it('validates a supplied libraryId before inserting', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 } as never) // library exists
      .mockResolvedValueOnce({ rows: [clientRow({ library_id: 'lib-1' })], rowCount: 1 } as never);
    const { createClient } = await import('./clients.js');
    const result = await createClient({ name: 'Acme', libraryId: 'lib-1' }, pool);
    expect(result.libraryId).toBe('lib-1');
  });

  it('rejects an unknown libraryId with ClientLibraryNotFoundError', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { createClient, ClientLibraryNotFoundError } = await import('./clients.js');
    await expect(createClient({ name: 'Acme', libraryId: 'nope' }, pool)).rejects.toBeInstanceOf(
      ClientLibraryNotFoundError
    );
  });

  it('wraps a raw db error as DatabaseError with its pg cause reachable', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const pgErr = Object.assign(new Error('dup'), { code: '23505' });
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { createClient } = await import('./clients.js');
    const err = await createClient({ name: 'dup' }, pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });

  it('TOCTOU: FK 23503 on insert (library deleted mid-race) → ClientLibraryNotFoundError', async () => {
    const { pool } = await import('../index.js');
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 } as never) // fast path: library exists
      .mockRejectedValueOnce(pgErr); // INSERT races a library delete → FK 23503
    const { createClient, ClientLibraryNotFoundError } = await import('./clients.js');
    const err = await createClient({ name: 'Acme', libraryId: 'lib-1' }, pool).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ClientLibraryNotFoundError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});

describe('updateClient', () => {
  it('updates and returns the firm section-number default', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [clientRow({ section_number_format: 'spaced-compact' })],
      rowCount: 1,
    } as never);
    const { updateClient } = await import('./clients.js');
    const result = await updateClient('c1', { sectionNumberFormat: 'spaced-compact' }, pool);
    expect(result?.sectionNumberFormat).toBe('spaced-compact');
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toContain('section_number_format = $2');
  });

  it('returns null for an unknown client', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { updateClient } = await import('./clients.js');
    await expect(
      updateClient('missing', { sectionNumberFormat: 'dots' }, pool)
    ).resolves.toBeNull();
  });
});

describe('listClients', () => {
  it('maps rows and orders by name, id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [clientRow()], rowCount: 1 } as never);
    const { listClients } = await import('./clients.js');
    const result = await listClients(pool);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('c1');
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toContain('ORDER BY name, id');
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { listClients } = await import('./clients.js');
    await expect(listClients(pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getClient', () => {
  it('returns null when the client is absent', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getClient } = await import('./clients.js');
    expect(await getClient('missing', pool)).toBeNull();
  });

  it('maps the client and its projects with sources, clientId and clientName', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [clientRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'p1',
            name: 'Campus A',
            description: null,
            client_id: 'c1',
            client_name: 'Acme',
            sources: [{ libraryId: 'l1', name: 'Co M', tier: 'company', priority: 1 }],
          },
        ],
        rowCount: 1,
      } as never);
    const { getClient } = await import('./clients.js');
    const result = await getClient('c1', pool);
    expect(result?.id).toBe('c1');
    expect(result?.projects).toHaveLength(1);
    expect(result?.projects[0]).toEqual({
      projectId: 'p1',
      name: 'Campus A',
      description: null,
      clientId: 'c1',
      clientName: 'Acme',
      sources: [{ libraryId: 'l1', name: 'Co M', tier: 'company', priority: 1 }],
    });
  });

  it('defaults a null sources aggregate to an empty array', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [clientRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'p1',
            name: 'P',
            description: null,
            client_id: 'c1',
            client_name: 'Acme',
            sources: null,
          },
        ],
        rowCount: 1,
      } as never);
    const { getClient } = await import('./clients.js');
    const result = await getClient('c1', pool);
    expect(result?.projects[0]?.sources).toEqual([]);
  });
});

describe('assertClientExists', () => {
  it('resolves when the client exists', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 } as never);
    const { assertClientExists } = await import('./clients.js');
    await expect(assertClientExists('c1', pool)).resolves.toBeUndefined();
  });

  it('throws ClientNotFoundError for an unknown id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { assertClientExists, ClientNotFoundError } = await import('./clients.js');
    await expect(assertClientExists('nope', pool)).rejects.toBeInstanceOf(ClientNotFoundError);
  });
});
