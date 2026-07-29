import { describe, it, expect, vi, beforeEach } from 'vitest';

// ADR-052 D9 (issue #380, task 8) — pending-summary.ts's own aggregation logic,
// isolated from the real DB: getLatestCheckpointBoundary (checkpoints.ts) is
// mocked, and pool.query calls are chained in the exact sequential order the
// implementation issues them (getProjectPendingSummary loops per spec
// sequentially, never via Promise.all, so this ordering is stable). What this
// file pins is pending-summary.ts's OWN branching and arithmetic: sealed vs
// never-sealed scoping, the DISTINCT-paragraph (never raw-op) count, the
// specs.project_id-only enumeration, and packageId as echo-only.

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
  pool: { query: vi.fn() },
}));
vi.mock('./checkpoints.js', () => ({
  getLatestCheckpointBoundary: vi.fn(),
}));
vi.mock('./edit-gate.js', () => ({
  SpecNotFoundError: class SpecNotFoundError extends MockDatabaseError {},
}));
vi.mock('./derive.js', () => ({
  ProjectNotFoundError: class ProjectNotFoundError extends MockDatabaseError {},
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = 'spec-1';
const PROJECT_ID = 'project-1';

describe('getSpecPendingSummary', () => {
  it('throws SpecNotFoundError when the spec does not exist', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const { getSpecPendingSummary } = await import('./pending-summary.js');
    const { SpecNotFoundError } = await import('./edit-gate.js');

    await expect(getSpecPendingSummary(SPEC_ID)).rejects.toBeInstanceOf(SpecNotFoundError);
  });

  it('reports never-sealed pending state (no checkpoint) scoped to every recorded version', async () => {
    const { pool } = await import('../index.js');
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');
    vi.mocked(getLatestCheckpointBoundary).mockResolvedValue(null);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ content_version: 5 }] } as never) // specContentVersion
      .mockResolvedValueOnce({
        rows: [{ user_id: 'u1', actor_label: 'Alice', changed_paragraph_count: 3 }],
      } as never); // actorRollupForSpec
    const { getSpecPendingSummary } = await import('./pending-summary.js');

    const result = await getSpecPendingSummary(SPEC_ID);

    expect(result).toEqual({
      specId: SPEC_ID,
      sealedByCheckpointId: null,
      sealedContentVersion: null,
      currentContentVersion: 5,
      changedParagraphCount: 3,
      actorRollup: [{ userId: 'u1', actorLabel: 'Alice', changedParagraphCount: 3 }],
    });
    const rollupCall = vi.mocked(pool.query).mock.calls[1];
    expect(rollupCall?.[0]).toContain('DISTINCT ON (paragraph_id)');
    expect(rollupCall?.[1]).toEqual([SPEC_ID, null]);
  });

  it('scopes the pending rollup to versions strictly after the sealed content_version', async () => {
    const { pool } = await import('../index.js');
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');
    vi.mocked(getLatestCheckpointBoundary).mockResolvedValue({
      checkpointId: 'cp-1',
      at: '2026-01-01T00:00:00Z',
      contentVersion: 7,
      specId: SPEC_ID,
    });
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ content_version: 10 }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const { getSpecPendingSummary } = await import('./pending-summary.js');

    const result = await getSpecPendingSummary(SPEC_ID);

    expect(result.sealedByCheckpointId).toBe('cp-1');
    expect(result.sealedContentVersion).toBe(7);
    expect(result.currentContentVersion).toBe(10);
    expect(result.changedParagraphCount).toBe(0);
    const rollupCall = vi.mocked(pool.query).mock.calls[1];
    expect(rollupCall?.[0]).toContain('content_version > $2');
    expect(rollupCall?.[1]).toEqual([SPEC_ID, 7]);
  });

  it('derives changedParagraphCount from the DISTINCT-paragraph actor rollup — never proportional to raw op count', async () => {
    const { pool } = await import('../index.js');
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');
    vi.mocked(getLatestCheckpointBoundary).mockResolvedValue(null);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ content_version: 1 }] } as never)
      // One actor, one paragraph — the SQL's own DISTINCT ON is what collapses
      // however many raw ops that paragraph accumulated into this single row;
      // this pins that the total is read straight off the rollup rather than
      // a separate raw-count query that could reintroduce a proportional count.
      .mockResolvedValueOnce({
        rows: [{ user_id: 'u1', actor_label: 'Alice', changed_paragraph_count: 1 }],
      } as never);
    const { getSpecPendingSummary } = await import('./pending-summary.js');

    const result = await getSpecPendingSummary(SPEC_ID);

    expect(result.changedParagraphCount).toBe(1);
  });

  it('wraps a raw db failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('connection lost'));
    const { getSpecPendingSummary } = await import('./pending-summary.js');

    await expect(getSpecPendingSummary(SPEC_ID)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('getProjectPendingSummary', () => {
  it('throws ProjectNotFoundError when the project does not exist', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as never);
    const { getProjectPendingSummary } = await import('./pending-summary.js');
    const { ProjectNotFoundError } = await import('./derive.js');

    await expect(getProjectPendingSummary(PROJECT_ID)).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('enumerates specs via specs.project_id = $1, never project_specs', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] } as never) // assertProjectExists
      .mockResolvedValueOnce({ rows: [] } as never); // projectSpecRows — empty project
    const { getProjectPendingSummary } = await import('./pending-summary.js');

    await getProjectPendingSummary(PROJECT_ID);

    const enumerateCall = vi.mocked(pool.query).mock.calls[1];
    expect(enumerateCall?.[0]).toContain('FROM specs WHERE project_id');
    expect(enumerateCall?.[0]).not.toContain('project_specs');
    expect(enumerateCall?.[1]).toEqual([PROJECT_ID]);
  });

  it('aggregates per-spec summaries and echoes packageId without using it to scope any query', async () => {
    const { pool } = await import('../index.js');
    const { getLatestCheckpointBoundary } = await import('./checkpoints.js');
    vi.mocked(getLatestCheckpointBoundary).mockResolvedValue(null);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] } as never) // assertProjectExists
      .mockResolvedValueOnce({
        rows: [
          { id: 'spec-a', content_version: 3 },
          { id: 'spec-b', content_version: 8 },
        ],
      } as never) // projectSpecRows
      .mockResolvedValueOnce({
        rows: [{ user_id: 'u1', actor_label: 'Alice', changed_paragraph_count: 2 }],
      } as never) // rollup for spec-a
      .mockResolvedValueOnce({ rows: [] } as never); // rollup for spec-b — nothing pending
    const { getProjectPendingSummary } = await import('./pending-summary.js');

    const result = await getProjectPendingSummary(PROJECT_ID, 'pkg-1');

    expect(result.packageId).toBe('pkg-1');
    expect(result.changedSpecCount).toBe(1);
    expect(result.changedParagraphCount).toBe(2);
    expect(result.actorRollup).toEqual([
      { userId: 'u1', actorLabel: 'Alice', changedParagraphCount: 2 },
    ]);
    expect(result.perSpec.map((s) => s.specId)).toEqual(['spec-a', 'spec-b']);
    for (const [, params] of vi.mocked(pool.query).mock.calls) {
      expect(params).not.toContain('pkg-1');
    }
  });

  it('returns a zeroed summary for a project with no owned specs', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rowCount: 1, rows: [{}] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const { getProjectPendingSummary } = await import('./pending-summary.js');

    const result = await getProjectPendingSummary(PROJECT_ID);

    expect(result).toEqual({
      projectId: PROJECT_ID,
      packageId: null,
      changedSpecCount: 0,
      changedParagraphCount: 0,
      actorRollup: [],
      perSpec: [],
    });
  });

  it('wraps a raw db failure in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('connection lost'));
    const { getProjectPendingSummary } = await import('./pending-summary.js');

    await expect(getProjectPendingSummary(PROJECT_ID)).rejects.toBeInstanceOf(DatabaseError);
  });
});
