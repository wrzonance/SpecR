import { describe, it, expect, vi, beforeEach } from 'vitest';

// DatabaseError is imported by projects.ts from '../errors.js' (leaf module).
// We must mock both '../errors.js' and '../index.js' with the SAME class so
// instanceof checks inside projects.ts work against what the test asserts.
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

describe('createProject', () => {
  it('validates source tiers, inserts project + sources, returns sources in priority order', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [
          { id: 'lib-client', name: 'Client M', tier: 'client' },
          { id: 'lib-co', name: 'Co M', tier: 'company' },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'proj-1', name: 'Test Project', description: null }],
        rowCount: 1,
      } as never);
    const { createProject } = await import('./projects.js');
    const result = await createProject(
      { name: 'Test Project', sourceLibraryIds: ['lib-client', 'lib-co'] },
      pool
    );
    expect(result.projectId).toBe('proj-1');
    expect(result.sources).toEqual([
      { libraryId: 'lib-client', name: 'Client M', tier: 'client', priority: 1 },
      { libraryId: 'lib-co', name: 'Co M', tier: 'company', priority: 2 },
    ]);
  });

  it('rejects a reference-tier source library (ADR-015 D3)', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'lib-ref', name: 'UFGS Reference', tier: 'reference' }],
      rowCount: 1,
    } as never);
    const { createProject, InvalidSourceLibraryError } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-ref'] }, pool)
    ).rejects.toBeInstanceOf(InvalidSourceLibraryError);
  });

  it('rejects an unknown source library id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { createProject, InvalidSourceLibraryError } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-missing'] }, pool)
    ).rejects.toBeInstanceOf(InvalidSourceLibraryError);
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { createProject } = await import('./projects.js');
    await expect(
      createProject({ name: 'x', sourceLibraryIds: ['lib-1'] }, pool)
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('findProjectById', () => {
  it('returns null when project not found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { findProjectById } = await import('./projects.js');
    const result = await findProjectById('missing', pool);
    expect(result).toBeNull();
  });

  it('returns ProjectWithToc with ordered toc entries', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [{ id: 'proj-1', name: 'My Project', description: 'desc' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { id: 'spec-1', section: '03 30 00', title: 'Concrete', position: 1 },
          { id: 'spec-2', section: '09 91 00', title: 'Painting', position: 2 },
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ library_id: 'lib-1', name: 'Co M', tier: 'company', priority: 1 }],
        rowCount: 1,
      } as never);
    const { findProjectById } = await import('./projects.js');
    const result = await findProjectById('proj-1', pool);
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe('proj-1');
    expect(result?.toc).toHaveLength(2);
    expect(result?.toc[0]?.specId).toBe('spec-1');
    expect(result?.sources).toEqual([
      { libraryId: 'lib-1', name: 'Co M', tier: 'company', priority: 1 },
    ]);
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { findProjectById } = await import('./projects.js');
    await expect(findProjectById('proj-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getBrokenRefs', () => {
  it('returns empty array when no broken refs', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getBrokenRefs } = await import('./projects.js');
    const result = await getBrokenRefs('proj-1', pool);
    expect(result).toHaveLength(0);
  });

  it('returns mapped BrokenRef array', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          id: 'ref-1',
          source_spec_id: 'spec-1',
          source_spec_section: '03 30 00',
          target_spec_section: '09 91 00',
          reference_text: 'See Section 09 91 00',
        },
      ],
      rowCount: 1,
    } as never);
    const { getBrokenRefs } = await import('./projects.js');
    const result = await getBrokenRefs('proj-1', pool);
    expect(result).toHaveLength(1);
    expect(result[0]?.refId).toBe('ref-1');
    expect(result[0]?.targetSpecSection).toBe('09 91 00');
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getBrokenRefs } = await import('./projects.js');
    await expect(getBrokenRefs('proj-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});
