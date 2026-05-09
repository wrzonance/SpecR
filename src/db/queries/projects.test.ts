import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index.js', () => ({
  DatabaseError: class DatabaseError extends Error {
    cause?: unknown;
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
      this.cause = options?.cause;
    }
  },
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
  it('returns ProjectSummary on success', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'proj-1', name: 'Test Project', description: null }],
      rowCount: 1,
    } as never);
    const { createProject } = await import('./projects.js');
    const result = await createProject({ name: 'Test Project' }, pool);
    expect(result.projectId).toBe('proj-1');
    expect(result.name).toBe('Test Project');
    expect(result.description).toBeNull();
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { createProject } = await import('./projects.js');
    await expect(createProject({ name: 'x' }, pool)).rejects.toBeInstanceOf(DatabaseError);
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
      } as never);
    const { findProjectById } = await import('./projects.js');
    const result = await findProjectById('proj-1', pool);
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe('proj-1');
    expect(result?.toc).toHaveLength(2);
    expect(result?.toc[0]?.specId).toBe('spec-1');
  });

  it('throws DatabaseError on query failure', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { findProjectById } = await import('./projects.js');
    await expect(findProjectById('proj-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('addSpecToProject', () => {
  it('returns AddSpecResult from single atomic CTE with project-scoped ref repair', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ spec_id: 'spec-1', position: 3 }],
      rowCount: 1,
    } as never);
    const { addSpecToProject } = await import('./projects.js');
    const result = await addSpecToProject('proj-1', 'spec-1', pool);
    expect(result.specId).toBe('spec-1');
    expect(result.position).toBe(3);
    expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(1);
    const sql = (vi.mocked(pool.query).mock.calls[0]?.[0] as string) ?? '';
    expect(sql).toContain('ps.project_id = $1');
  });

  it('throws DatabaseError when insert fails', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('fk violation'));
    const { addSpecToProject } = await import('./projects.js');
    await expect(addSpecToProject('proj-1', 'spec-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('removeSpecFromProject', () => {
  it('returns false when row not found (deleted_count = 0)', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ deleted_count: 0 }],
      rowCount: 1,
    } as never);
    const { removeSpecFromProject } = await import('./projects.js');
    const result = await removeSpecFromProject('proj-1', 'spec-1', pool);
    expect(result).toBe(false);
  });

  it('marks broken refs atomically, project-scoped, excluding removed spec itself', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ deleted_count: 1 }],
      rowCount: 1,
    } as never);
    const { removeSpecFromProject } = await import('./projects.js');
    const result = await removeSpecFromProject('proj-1', 'spec-1', pool);
    expect(result).toBe(true);
    expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(1);
    const sql = (vi.mocked(pool.query).mock.calls[0]?.[0] as string) ?? '';
    expect(sql).toContain('ps.project_id = $1');
    expect(sql).toContain('source_spec_id <> $2');
  });

  it('throws DatabaseError when delete fails', async () => {
    const { DatabaseError, pool } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { removeSpecFromProject } = await import('./projects.js');
    await expect(removeSpecFromProject('proj-1', 'spec-1', pool)).rejects.toBeInstanceOf(
      DatabaseError
    );
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
