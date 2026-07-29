import { describe, it, expect, vi, beforeEach } from 'vitest';

// ADR-052 D4 (issue #380, task 7) — rejectParagraphToCheckpoint's own
// resolve-then-delegate logic, isolated from the real DB: getCheckpointBoundariesForSpec
// and the raw paragraph_versions lookup are mocked, and updateParagraphText (the
// actual write) is mocked as a black box — its own gate/ownership/transaction
// behavior is already covered by paragraphs.integration.test.ts. What this file
// pins is rejectParagraphToCheckpoint's OWN branching: which checkpoint/paragraph
// combination maps to which RejectParagraphResult, and — the core invariant —
// that the delegate call NEVER threads an expectedVersion through.

vi.mock('../index.js', () => ({
  pool: { query: vi.fn() },
  DatabaseError: class DatabaseError extends Error {
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
    }
  },
  updateParagraphText: vi.fn(),
  getParagraphSpecId: vi.fn(),
}));

vi.mock('./checkpoints.js', () => ({
  getCheckpointBoundariesForSpec: vi.fn(),
}));

const SPEC_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_SPEC_ID = 'aaaaaaaa-0000-0000-0000-000000000009';
const PARAGRAPH_ID = 'aaaaaaaa-0000-0000-0000-000000000002';
const CHECKPOINT_ID = 'aaaaaaaa-0000-0000-0000-000000000003';
const SEALED_BOUNDARY = {
  checkpointId: CHECKPOINT_ID,
  at: '2026-01-01T00:00:00Z',
  contentVersion: 3,
  specId: SPEC_ID,
};

describe('rejectParagraphToCheckpoint', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns checkpoint-not-found when the checkpoint never sealed this spec', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([]);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID);

    expect(result).toEqual({ status: 'checkpoint-not-found' });
  });

  it('returns not-found when no sealed snapshot exists and the paragraph does not exist at all', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, getParagraphSpecId } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getParagraphSpecId).mockResolvedValue(null);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID);

    expect(result).toEqual({ status: 'not-found' });
  });

  it('returns wrong-spec when no sealed snapshot exists and the paragraph belongs to a different spec', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, getParagraphSpecId } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getParagraphSpecId).mockResolvedValue(OTHER_SPEC_ID);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID);

    expect(result).toEqual({ status: 'wrong-spec' });
  });

  it('returns no-checkpointed-state when the paragraph exists in this spec but has no snapshot at or before the checkpoint', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, getParagraphSpecId } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getParagraphSpecId).mockResolvedValue(SPEC_ID);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID);

    expect(result).toEqual({ status: 'no-checkpointed-state' });
  });

  it('reverts to the sealed text and NEVER passes expectedVersion to updateParagraphText (ADR-052 D4 — unconditional overwrite)', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, updateParagraphText } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ text: 'Sealed text' }] } as never);
    const node = { id: PARAGRAPH_ID, type: 'pr1', text: 'Sealed text', children: [], meta: {} };
    vi.mocked(updateParagraphText).mockResolvedValue({ status: 'updated', node } as never);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID, 'alice');

    expect(result).toEqual({ status: 'reverted', node });
    // The invariant: no 4th (expectedVersion) argument, ever — a concurrent edit
    // made after the checkpoint must never make this call fail stale.
    expect(updateParagraphText).toHaveBeenCalledWith(
      SPEC_ID,
      PARAGRAPH_ID,
      'Sealed text',
      undefined,
      'alice'
    );
  });

  it('passes through a locked-object refusal from updateParagraphText unchanged', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, updateParagraphText } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ text: 'Sealed blob text' }] } as never);
    vi.mocked(updateParagraphText).mockResolvedValue({
      status: 'locked-object',
      nodeType: 'object',
    } as never);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const result = await rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID);

    expect(result).toEqual({ status: 'locked-object', nodeType: 'object' });
  });

  it('paragraph-reject: uppercase checkpointId still resolves the sealed boundary (case-fold gap)', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, getParagraphSpecId } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getParagraphSpecId).mockResolvedValue(SPEC_ID);

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    // CHECKPOINT_ID as stored by pg is canonical lowercase; a caller-supplied
    // uppercase UUID is still valid per z.uuid() and must resolve the same boundary.
    const result = await rejectParagraphToCheckpoint(
      SPEC_ID,
      PARAGRAPH_ID,
      CHECKPOINT_ID.toUpperCase()
    );

    expect(result).toEqual({ status: 'no-checkpointed-state' });
  });

  it('wraps a raw failure (e.g. a lost connection) in DatabaseError', async () => {
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockRejectedValue(new Error('connection lost'));

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');
    const { DatabaseError } = await import('../index.js');

    await expect(
      rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID)
    ).rejects.toBeInstanceOf(DatabaseError);
  });

  it('paragraph-reject: a failure inside the missing-sealed-state classifier is still wrapped in DatabaseError (unawaited-return gap)', async () => {
    // Regression: the classifier was `return`ed, not `await`ed, from inside the
    // try — its rejection settled after the catch had already exited, so a raw
    // Error escaped this module boundary unwrapped.
    const { getCheckpointBoundariesForSpec } = await import('./checkpoints.js');
    vi.mocked(getCheckpointBoundariesForSpec).mockResolvedValue([SEALED_BOUNDARY]);
    const { pool, getParagraphSpecId, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.mocked(getParagraphSpecId).mockRejectedValue(new Error('connection lost'));

    const { rejectParagraphToCheckpoint } = await import('./paragraph-reject.js');

    await expect(
      rejectParagraphToCheckpoint(SPEC_ID, PARAGRAPH_ID, CHECKPOINT_ID)
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
