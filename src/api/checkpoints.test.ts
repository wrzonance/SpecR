import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  createCheckpointForActor: vi.fn(),
  listCheckpoints: vi.fn(),
  getCheckpointById: vi.fn(),
  CheckpointScopeNotFoundError: class CheckpointScopeNotFoundError extends Error {},
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const SPEC_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000003';
const USER_ID = '00000000-0000-4000-8000-000000000004';

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, query: {}, body: {}, ...overrides } as unknown as Request;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('checkpoints API — request validation', () => {
  it('rejects a malformed spec id at the boundary before touching the db', async () => {
    const { createSpecCheckpointHandler } = await import('./checkpoints.js');
    const { createCheckpointForActor } = await import('../db/index.js');
    const res = makeRes();

    await createSpecCheckpointHandler(
      makeReq({ params: { id: 'nope' }, body: { name: 'Review 1', actorLabel: 'alice' } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCheckpointForActor).not.toHaveBeenCalled();
  });

  it('rejects a body missing the required actorLabel', async () => {
    const { createProjectCheckpointHandler } = await import('./checkpoints.js');
    const { createCheckpointForActor } = await import('../db/index.js');
    const res = makeRes();

    await createProjectCheckpointHandler(
      makeReq({ params: { id: PROJECT_ID }, body: { name: 'Review 1' } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createCheckpointForActor).not.toHaveBeenCalled();
  });

  it('rejects a malformed checkpoint id on the single-resource read', async () => {
    const { getCheckpointHandler } = await import('./checkpoints.js');
    const res = makeRes();

    await getCheckpointHandler(makeReq({ params: { id: 'nope' } }), res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('checkpoints API — create', () => {
  it('seals a spec-scoped checkpoint by delegating name/scope/actorLabel to createCheckpointForActor', async () => {
    const { createSpecCheckpointHandler } = await import('./checkpoints.js');
    const { createCheckpointForActor } = await import('../db/index.js');
    const checkpoint = {
      id: CHECKPOINT_ID,
      name: 'Review 1',
      scope: 'spec' as const,
      scopeId: SPEC_ID,
      userId: USER_ID,
      contentVersionMap: { [SPEC_ID]: 3 },
      createdAt: '2026-07-27T00:00:00.000Z',
    };
    vi.mocked(createCheckpointForActor).mockResolvedValueOnce(checkpoint);
    const res = makeRes();

    await createSpecCheckpointHandler(
      makeReq({ params: { id: SPEC_ID }, body: { name: 'Review 1', actorLabel: 'alice' } }),
      res as unknown as Response
    );

    // Actor resolution and the checkpoint insert are ONE transaction inside
    // createCheckpointForActor (#380 review finding) — the handler itself
    // makes exactly this one call, never resolving the actor separately.
    expect(createCheckpointForActor).toHaveBeenCalledWith({
      name: 'Review 1',
      scope: 'spec',
      scopeId: SPEC_ID,
      actorLabel: 'alice',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: checkpoint });
  });

  it('maps CheckpointScopeNotFoundError to 404', async () => {
    const { createProjectCheckpointHandler } = await import('./checkpoints.js');
    const { createCheckpointForActor, CheckpointScopeNotFoundError } =
      await import('../db/index.js');
    vi.mocked(createCheckpointForActor).mockRejectedValueOnce(
      new CheckpointScopeNotFoundError('project nope not found')
    );
    const res = makeRes();

    await createProjectCheckpointHandler(
      makeReq({ params: { id: PROJECT_ID }, body: { name: 'Review 1', actorLabel: 'alice' } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('logs and returns 500 on an unexpected create failure', async () => {
    const { createSpecCheckpointHandler } = await import('./checkpoints.js');
    const { createCheckpointForActor } = await import('../db/index.js');
    const { logger } = await import('../lib/logger.js');
    const err = new Error('connection lost');
    vi.mocked(createCheckpointForActor).mockRejectedValueOnce(err);
    const res = makeRes();

    await createSpecCheckpointHandler(
      makeReq({ params: { id: SPEC_ID }, body: { name: 'Review 1', actorLabel: 'alice' } }),
      res as unknown as Response
    );

    expect(logger.error).toHaveBeenCalledWith({ err }, 'create checkpoint failed');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('checkpoints API — list and read', () => {
  it('lists spec-scoped checkpoints without ever touching project scope', async () => {
    const { listSpecCheckpointsHandler } = await import('./checkpoints.js');
    const { listCheckpoints } = await import('../db/index.js');
    vi.mocked(listCheckpoints).mockResolvedValueOnce([]);
    const res = makeRes();

    await listSpecCheckpointsHandler(
      makeReq({ params: { id: SPEC_ID } }),
      res as unknown as Response
    );

    expect(listCheckpoints).toHaveBeenCalledWith('spec', SPEC_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  it('lists project-scoped checkpoints', async () => {
    const { listProjectCheckpointsHandler } = await import('./checkpoints.js');
    const { listCheckpoints } = await import('../db/index.js');
    vi.mocked(listCheckpoints).mockResolvedValueOnce([]);
    const res = makeRes();

    await listProjectCheckpointsHandler(
      makeReq({ params: { id: PROJECT_ID } }),
      res as unknown as Response
    );

    expect(listCheckpoints).toHaveBeenCalledWith('project', PROJECT_ID);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when a checkpoint id resolves to nothing', async () => {
    const { getCheckpointHandler } = await import('./checkpoints.js');
    const { getCheckpointById } = await import('../db/index.js');
    vi.mocked(getCheckpointById).mockResolvedValueOnce(null);
    const res = makeRes();

    await getCheckpointHandler(
      makeReq({ params: { id: CHECKPOINT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
