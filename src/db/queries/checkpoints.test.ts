import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror clients.test.ts: mock the DatabaseError class the module-under-test sees
// (checkpoints.ts imports it from '../index.js') so instanceof checks line up.
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

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const NOW = new Date('2026-07-27T00:00:00.000Z');

const specCheckpointRow = (over: Record<string, unknown> = {}) => ({
  id: 'cp-1',
  name: 'Reviewed 07/27',
  spec_id: 's1',
  project_id: null,
  user_id: 'u1',
  content_version_map: { s1: 3 },
  created_at: NOW,
  ...over,
});

const projectCheckpointRow = (over: Record<string, unknown> = {}) => ({
  id: 'cp-2',
  name: 'Addendum 1 baseline',
  spec_id: null,
  project_id: 'proj-1',
  user_id: 'u1',
  content_version_map: { s1: 3, s2: 7 },
  created_at: NOW,
  ...over,
});

describe('createCheckpoint', () => {
  it('inserts a spec-scoped checkpoint via the atomic snapshot statement', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [specCheckpointRow()],
      rowCount: 1,
    } as never);
    const { createCheckpoint } = await import('./checkpoints.js');

    const result = await createCheckpoint(
      { name: 'Reviewed 07/27', scope: 'spec', scopeId: 's1', userId: 'u1' },
      pool
    );

    expect(result).toEqual({
      id: 'cp-1',
      name: 'Reviewed 07/27',
      scope: 'spec',
      scopeId: 's1',
      userId: 'u1',
      contentVersionMap: { s1: 3 },
      createdAt: NOW.toISOString(),
    });
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    const params = vi.mocked(pool.query).mock.calls[0]?.[1];
    expect(sql).toContain('INSERT INTO checkpoints (name, spec_id, user_id, content_version_map)');
    expect(sql).toContain('SELECT content_version FROM specs WHERE id = $2');
    expect(params).toEqual(['Reviewed 07/27', 's1', 'u1']);
  });

  it('inserts a project-scoped checkpoint aggregating every in-scope spec', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [projectCheckpointRow()],
      rowCount: 1,
    } as never);
    const { createCheckpoint } = await import('./checkpoints.js');

    const result = await createCheckpoint(
      { name: 'Addendum 1 baseline', scope: 'project', scopeId: 'proj-1', userId: 'u1' },
      pool
    );

    expect(result.scope).toBe('project');
    expect(result.scopeId).toBe('proj-1');
    expect(result.contentVersionMap).toEqual({ s1: 3, s2: 7 });
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    const params = vi.mocked(pool.query).mock.calls[0]?.[1];
    expect(sql).toContain(
      'INSERT INTO checkpoints (name, project_id, user_id, content_version_map)'
    );
    expect(sql).toContain('jsonb_object_agg(id::text, content_version)');
    expect(sql).toContain('WHERE project_id = $2');
    expect(params).toEqual(['Addendum 1 baseline', 'proj-1', 'u1']);
  });

  it('throws DatabaseError when no row is returned after insert', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { createCheckpoint } = await import('./checkpoints.js');

    await expect(
      createCheckpoint({ name: 'x', scope: 'spec', scopeId: 's1', userId: 'u1' }, pool)
    ).rejects.toBeInstanceOf(DatabaseError);
  });

  it('remaps an FK 23503 (unknown scopeId) to CheckpointScopeNotFoundError', async () => {
    const { pool } = await import('../index.js');
    const pgErr = Object.assign(new Error('fk violation'), { code: '23503' });
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { createCheckpoint, CheckpointScopeNotFoundError } = await import('./checkpoints.js');

    const err = await createCheckpoint(
      { name: 'x', scope: 'spec', scopeId: 'missing', userId: 'u1' },
      pool
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CheckpointScopeNotFoundError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });

  it('wraps an unrelated raw db error as a plain DatabaseError with its cause chained', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const pgErr = Object.assign(new Error('db down'), { code: '53300' });
    vi.mocked(pool.query).mockRejectedValueOnce(pgErr);
    const { createCheckpoint } = await import('./checkpoints.js');

    const err = await createCheckpoint(
      { name: 'x', scope: 'spec', scopeId: 's1', userId: 'u1' },
      pool
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});

describe('row mapping (scope XOR safety net)', () => {
  it('throws a typed DatabaseError if a row somehow has neither spec_id nor project_id set', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [specCheckpointRow({ spec_id: null, project_id: null })],
      rowCount: 1,
    } as never);
    const { getCheckpointById } = await import('./checkpoints.js');

    await expect(getCheckpointById('cp-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('listCheckpoints', () => {
  it('filters on spec_id for scope "spec", most recent first', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [specCheckpointRow()],
      rowCount: 1,
    } as never);
    const { listCheckpoints } = await import('./checkpoints.js');

    const result = await listCheckpoints('spec', 's1', pool);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('cp-1');
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    const params = vi.mocked(pool.query).mock.calls[0]?.[1];
    expect(sql).toContain('WHERE spec_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(params).toEqual(['s1']);
  });

  it('filters on project_id for scope "project"', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [projectCheckpointRow()],
      rowCount: 1,
    } as never);
    const { listCheckpoints } = await import('./checkpoints.js');

    await listCheckpoints('project', 'proj-1', pool);

    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    expect(sql).toContain('WHERE project_id = $1');
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { listCheckpoints } = await import('./checkpoints.js');

    await expect(listCheckpoints('spec', 's1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getCheckpointById', () => {
  it('returns null for an unknown id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getCheckpointById } = await import('./checkpoints.js');

    await expect(getCheckpointById('missing', pool)).resolves.toBeNull();
  });

  it('maps a found project-scoped row', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [projectCheckpointRow()],
      rowCount: 1,
    } as never);
    const { getCheckpointById } = await import('./checkpoints.js');

    const result = await getCheckpointById('cp-2', pool);

    expect(result?.scope).toBe('project');
    expect(result?.scopeId).toBe('proj-1');
  });
});

describe('getCheckpointBoundariesForSpec', () => {
  it('maps ascending boundary rows and queries by JSONB key existence', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [
        { id: 'cp-1', created_at: NOW, content_version: 3 },
        { id: 'cp-2', created_at: NOW, content_version: 7 },
      ],
      rowCount: 2,
    } as never);
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');

    const result = await getCheckpointBoundariesForSpec('s1', pool);

    expect(result).toEqual([
      { checkpointId: 'cp-1', at: NOW.toISOString(), contentVersion: 3 },
      { checkpointId: 'cp-2', at: NOW.toISOString(), contentVersion: 7 },
    ]);
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    const params = vi.mocked(pool.query).mock.calls[0]?.[1];
    expect(sql).toContain('content_version_map ? $1::text');
    expect(sql).toContain('ORDER BY content_version ASC, created_at ASC, id ASC');
    expect(params).toEqual(['s1']);
  });

  it('returns [] when no checkpoint applies to the spec', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');

    await expect(getCheckpointBoundariesForSpec('s1', pool)).resolves.toEqual([]);
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');

    await expect(getCheckpointBoundariesForSpec('s1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getLatestCheckpointBoundary', () => {
  it('returns null when no checkpoint applies to the spec', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');

    await expect(getLatestCheckpointBoundary('s1', pool)).resolves.toBeNull();
  });

  it('queries descending by contentVersion, limit 1', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'cp-2', created_at: NOW, content_version: 7 }],
      rowCount: 1,
    } as never);
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');

    const result = await getLatestCheckpointBoundary('s1', pool);

    expect(result).toEqual({ checkpointId: 'cp-2', at: NOW.toISOString(), contentVersion: 7 });
    const sql = vi.mocked(pool.query).mock.calls[0]?.[0];
    expect(sql).toContain('ORDER BY content_version DESC, created_at DESC, id DESC');
    expect(sql).toContain('LIMIT 1');
  });

  it('throws DatabaseError on query failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');

    await expect(getLatestCheckpointBoundary('s1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});
