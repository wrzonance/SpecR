import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  rejectParagraphToCheckpoint: vi.fn(),
  lockedObjectMessage: vi.fn((nodeType: string) => `${nodeType} is locked`),
  SpecNotFoundError: class SpecNotFoundError extends Error {},
  SpecWriteForbiddenError: class SpecWriteForbiddenError extends Error {},
  StaleVersionError: class StaleVersionError extends Error {
    currentVersion: number;
    constructor(message: string, currentVersion: number) {
      super(message);
      this.currentVersion = currentVersion;
    }
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const SPEC_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000003';

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, body: {}, ...overrides } as unknown as Request;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('paragraph-reject API — request validation', () => {
  it('rejects a malformed spec id', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const { rejectParagraphToCheckpoint } = await import('../db/index.js');
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: 'nope', nodeId: NODE_ID }, body: { checkpointId: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(rejectParagraphToCheckpoint).not.toHaveBeenCalled();
  });

  it('rejects a malformed node id', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: 'nope' }, body: { checkpointId: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a body missing checkpointId', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, body: {} }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('paragraph-reject API — result mapping', () => {
  const CASES: readonly [unknown, number][] = [
    [{ status: 'not-found' }, 404],
    [{ status: 'wrong-spec' }, 403],
    [{ status: 'locked-object', nodeType: 'object' }, 422],
    [{ status: 'checkpoint-not-found' }, 404],
    [{ status: 'no-checkpointed-state' }, 422],
  ];

  it.each(CASES)('maps result %o to status %i', async (result, status) => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const { rejectParagraphToCheckpoint } = await import('../db/index.js');
    vi.mocked(rejectParagraphToCheckpoint).mockResolvedValueOnce(
      result as Awaited<ReturnType<typeof rejectParagraphToCheckpoint>>
    );
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, body: { checkpointId: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(status);
  });

  it('returns the reverted node on success and threads actorLabel through', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const { rejectParagraphToCheckpoint } = await import('../db/index.js');
    const node = { id: NODE_ID, type: 'pr1', text: 'Sealed text' };
    vi.mocked(rejectParagraphToCheckpoint).mockResolvedValueOnce({
      status: 'reverted',
      node,
    } as Awaited<ReturnType<typeof rejectParagraphToCheckpoint>>);
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({
        params: { id: SPEC_ID, nodeId: NODE_ID },
        body: { checkpointId: CHECKPOINT_ID, actorLabel: 'alice' },
      }),
      res as unknown as Response
    );

    expect(rejectParagraphToCheckpoint).toHaveBeenCalledWith(
      SPEC_ID,
      NODE_ID,
      CHECKPOINT_ID,
      'alice'
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: node });
  });

  it('maps a SpecWriteForbiddenError (archived/upstream-locked spec) to 409', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const { rejectParagraphToCheckpoint, SpecWriteForbiddenError } = await import('../db/index.js');
    vi.mocked(rejectParagraphToCheckpoint).mockRejectedValueOnce(
      new SpecWriteForbiddenError('spec is archived')
    );
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, body: { checkpointId: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('logs and returns 500 on an unexpected failure', async () => {
    const { rejectParagraphHandler } = await import('./paragraph-reject.js');
    const { rejectParagraphToCheckpoint } = await import('../db/index.js');
    const { logger } = await import('../lib/logger.js');
    const err = new Error('connection lost');
    vi.mocked(rejectParagraphToCheckpoint).mockRejectedValueOnce(err);
    const res = makeRes();

    await rejectParagraphHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, body: { checkpointId: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(logger.error).toHaveBeenCalledWith({ err }, 'reject paragraph failed');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
