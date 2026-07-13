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

// updateProject validates a non-null clientId via assertClientExists; stub it so this
// suite tests the update path, not the clients module (covered by clients.test.ts).
// ClientNotFoundError is re-thrown on the TOCTOU FK path, so it must be a real class here.
vi.mock('./clients.js', () => ({
  assertClientExists: vi.fn(),
  ClientNotFoundError: class ClientNotFoundError extends MockDatabaseError {},
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

// The spec's sole-owning-project section-number-format fallback moved into
// resolveSpecGenerationContext (src/db/queries/header-footer-context.ts, #479),
// which resolves ownership once for both numbering and header/footer; its
// coverage lives in header-footer-context.integration.test.ts. The pure
// string→format coercion is covered in src/lib/section-number.test.ts.

describe('listProjects', () => {
  it('returns project ids and names', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        { id: 'project-a', name: 'Alpha' },
        { id: 'project-b', name: 'Beta' },
      ],
      rowCount: 2,
    } as never);
    const { listProjects } = await import('./projects.js');
    await expect(listProjects(pool)).resolves.toEqual([
      { id: 'project-a', name: 'Alpha' },
      { id: 'project-b', name: 'Beta' },
    ]);
    expect(vi.mocked(pool.query).mock.calls[0]?.[0]).toContain('ORDER BY name, id');
  });

  it('throws DatabaseError on list failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { listProjects } = await import('./projects.js');
    await expect(listProjects(pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('updateProject client association', () => {
  it('sets client_id and returns clientId when a client is provided', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'P', section_number_format: 'canonical', client_id: 'c1' }],
      rowCount: 1,
    } as never);
    const { updateProject } = await import('./projects.js');
    const { assertClientExists } = await import('./clients.js');
    const result = await updateProject('p1', { clientId: 'c1' }, pool);
    expect(result?.clientId).toBe('c1');
    expect(assertClientExists).toHaveBeenCalledWith('c1', pool);
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    expect(sql).toContain('client_id = $2');
    expect(sql).toContain('RETURNING id, name, section_number_format, client_id');
  });

  it('clears the association on clientId null without validating', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'p1', name: 'P', section_number_format: 'canonical', client_id: null }],
      rowCount: 1,
    } as never);
    const { updateProject } = await import('./projects.js');
    const { assertClientExists } = await import('./clients.js');
    const result = await updateProject('p1', { clientId: null }, pool);
    expect(result?.clientId).toBeNull();
    expect(assertClientExists).not.toHaveBeenCalled();
  });

  it('rejects (before UPDATE) when the client does not exist', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { assertClientExists } = await import('./clients.js');
    vi.mocked(assertClientExists).mockRejectedValueOnce(new DatabaseError('client x not found'));
    const { updateProject } = await import('./projects.js');
    await expect(updateProject('p1', { clientId: 'x' }, pool)).rejects.toBeInstanceOf(
      DatabaseError
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('TOCTOU: FK 23503 on UPDATE (client deleted mid-race) → ClientNotFoundError', async () => {
    const { pool } = await import('../index.js');
    const { ClientNotFoundError } = await import('./clients.js');
    // assertClientExists (default vi.fn()) resolves, then the UPDATE races a client
    // delete and the ON DELETE RESTRICT FK raises 23503 — must surface as 422, not 500.
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { updateProject } = await import('./projects.js');
    const err = await updateProject('p1', { clientId: 'c1' }, pool).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientNotFoundError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});

describe('getBrokenRefs', () => {
  it('returns empty array when no broken refs', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getBrokenRefs } = await import('./project-refs.js');
    const result = await getBrokenRefs('proj-1', pool);
    expect(result).toHaveLength(0);
  });

  it('returns mapped BrokenRef array with availableFrom advisory', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        {
          id: 'ref-1',
          source_spec_id: 'spec-1',
          source_spec_section: '03 30 00',
          source_paragraph_id: 'para-1',
          source_paragraph_text: 'Coordinate finishes with See Section 09 91 00 as scheduled.',
          target_spec_section: '09 91 00',
          reference_text: 'See Section 09 91 00',
          available_from: [{ libraryId: 'lib-1', name: 'Co M' }],
        },
        {
          id: 'ref-2',
          source_spec_id: 'spec-1',
          source_spec_section: '03 30 00',
          source_paragraph_id: 'para-2',
          source_paragraph_text: 'See Section 99 99 99',
          target_spec_section: '99 99 99',
          reference_text: 'See Section 99 99 99',
          available_from: null,
        },
      ],
      rowCount: 2,
    } as never);
    const { getBrokenRefs } = await import('./project-refs.js');
    const result = await getBrokenRefs('proj-1', pool);
    expect(result[0]?.availableFrom).toEqual([{ libraryId: 'lib-1', name: 'Co M' }]);
    expect(result[1]?.availableFrom).toEqual([]);
    // Paragraph-level locator (#260): id threaded through, snippet built from text.
    expect(result[0]?.sourceParagraphId).toBe('para-1');
    expect(result[0]?.snippet).toContain('See Section 09 91 00');
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getBrokenRefs } = await import('./project-refs.js');
    await expect(getBrokenRefs('proj-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});
