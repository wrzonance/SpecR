import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror checkpoints.test.ts: mock the DatabaseError class the module-under-test (and its
// sibling imports, checkpoints.js/pg-errors.js) see via '../index.js', so instanceof checks
// line up across the whole call graph history.ts pulls in.
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
const SESSION_WINDOW_MS = 30 * 60 * 1000;

const contextRow = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  spec_id: 's1',
  origin_paragraph_id: null,
  base_version: 2,
  text: 'Row 2 text',
  node_type: 'pr1',
  created_at: NOW,
  updated_at: NOW,
  content_version: 2,
  parent_spec_id: null,
  origin_version: null,
  spec_created_at: NOW,
  ...over,
});

const historyRow = (over: Record<string, unknown> = {}) => ({
  spec_id: 's1',
  version: 1,
  text: 'v1 text',
  node_type: 'pr1',
  op: 'edit',
  content_version: 1,
  snapshot_at: NOW,
  payload: null,
  user_id: null,
  actor_label: null,
  ...over,
});

describe('getParagraphHistory — actor attribution (ADR-052 D1/D6)', () => {
  it('attaches userId/actorLabel per row, keeping both null for an unattributed row', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [contextRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          historyRow({ version: 1, content_version: 1, user_id: null, actor_label: null }),
          historyRow({
            version: 2,
            content_version: 2,
            user_id: 'u1',
            actor_label: 'Alice',
            text: 'Row 2 text',
          }),
        ],
        rowCount: 2,
      } as never);
    const { getParagraphHistory } = await import('./history.js');

    const result = await getParagraphHistory('s1', 'p1', false, pool);

    expect(result).toEqual([
      expect.objectContaining({ version: 1, userId: null, actorLabel: null }),
      expect.objectContaining({ version: 2, userId: 'u1', actorLabel: 'Alice' }),
    ]);
    const historySql = vi.mocked(pool.query).mock.calls[1]?.[0];
    expect(historySql).toContain('LEFT JOIN users u ON u.id = pv.user_id');
  });

  it('a fabricated current-tip entry always has null userId/actorLabel — never guessed', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [contextRow({ base_version: 3, text: 'Current text', content_version: 3 })],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [
          historyRow({
            version: 2,
            content_version: 2,
            user_id: 'u-bob',
            actor_label: 'Bob',
            text: 'Old text',
          }),
        ],
        rowCount: 1,
      } as never);
    const { getParagraphHistory } = await import('./history.js');

    const result = await getParagraphHistory('s1', 'p1', false, pool);

    expect(result).toHaveLength(2);
    expect(result?.[0]).toEqual(
      expect.objectContaining({ version: 2, userId: 'u-bob', actorLabel: 'Bob' })
    );
    expect(result?.[1]).toEqual(
      expect.objectContaining({ version: 3, op: 'edit', userId: null, actorLabel: null })
    );
  });
});

describe('getSpecHistory — checkpoint milestones (ADR-052 D3/D4)', () => {
  it('maps a checkpoint row into a checkpoint milestone alongside origin/revision', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({
        rows: [{ content_version: 2, created_at: NOW, parent_spec_id: null, origin_version: null }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // paragraph-op steps
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // revision milestones
      .mockResolvedValueOnce({
        rows: [{ id: 'cp-1', name: 'Reviewed 07/27', created_at: NOW, content_version: 2 }],
        rowCount: 1,
      } as never); // checkpoint milestones
    const { getSpecHistory } = await import('./history.js');

    const result = await getSpecHistory('s1', undefined, pool);

    expect(result?.milestones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'origin' }),
        expect.objectContaining({
          kind: 'checkpoint',
          checkpointId: 'cp-1',
          name: 'Reviewed 07/27',
          contentVersion: 2,
          at: NOW.toISOString(),
        }),
      ])
    );
    const checkpointSql = vi.mocked(pool.query).mock.calls[3]?.[0];
    const checkpointParams = vi.mocked(pool.query).mock.calls[3]?.[1];
    // Case-fold regression (#380 review finding) — mirrors checkpoints.ts's
    // getCheckpointBoundariesForSpec: a bare $1::text never matches a
    // differently-cased jsonb key.
    expect(checkpointSql).toContain('content_version_map ? $1::uuid::text');
    expect(checkpointParams).toEqual(['s1']);
  });
});

describe('getCoalescedParagraphHistory — tier-1 read (ADR-052 D3)', () => {
  it(
    'returns the same not-found null as getParagraphHistory for the same (specId, paragraphId) ' +
      '— coalescing never changes existence, only shape',
    async () => {
      const { pool } = await import('../index.js');
      vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      const { getParagraphHistory } = await import('./history.js');
      const notFoundFromRaw = await getParagraphHistory('s1', 'missing', false, pool);

      vi.mocked(pool.query).mockClear();
      vi.mocked(pool.query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      const { getCoalescedParagraphHistory } = await import('./history.js');
      const notFoundFromCoalesced = await getCoalescedParagraphHistory(
        's1',
        'missing',
        SESSION_WINDOW_MS,
        false,
        pool
      );

      expect(notFoundFromRaw).toBeNull();
      expect(notFoundFromCoalesced).toBeNull();
      // Not-found short-circuits before ever fetching checkpoint boundaries.
      expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(1);
    }
  );

  it("coalesces getParagraphHistory's entries against this spec's checkpoint boundaries", async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [contextRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({
        rows: [
          historyRow({ version: 1, content_version: 1, user_id: 'u1', actor_label: 'Alice' }),
          historyRow({
            version: 2,
            content_version: 2,
            user_id: 'u1',
            actor_label: 'Alice',
            text: 'Row 2 text',
          }),
        ],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ id: 'cp-1', created_at: NOW, content_version: 1 }],
        rowCount: 1,
      } as never);
    const { getCoalescedParagraphHistory } = await import('./history.js');

    const sessions = await getCoalescedParagraphHistory('s1', 'p1', SESSION_WINDOW_MS, false, pool);

    // The checkpoint at contentVersion 1 seals the first edit and opens a new
    // pending session at the edit that reaches contentVersion 2 (prev <= N < next).
    expect(sessions).toHaveLength(2);
    expect(sessions?.[0]).toEqual(
      expect.objectContaining({ sealedContentVersion: 1, sealedByCheckpointId: 'cp-1' })
    );
    expect(sessions?.[1]).toEqual(
      expect.objectContaining({ sealedContentVersion: 2, sealedByCheckpointId: null })
    );
    const boundarySql = vi.mocked(pool.query).mock.calls[2]?.[0];
    const boundaryParams = vi.mocked(pool.query).mock.calls[2]?.[1];
    // Case-fold regression (#380 review finding) — see checkpointMilestones above.
    expect(boundarySql).toContain('content_version_map ? $1::uuid::text');
    expect(boundaryParams).toEqual(['s1']);
  });

  it('wraps a raw db error as a DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { getCoalescedParagraphHistory } = await import('./history.js');

    await expect(
      getCoalescedParagraphHistory('s1', 'p1', SESSION_WINDOW_MS, false, pool)
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
