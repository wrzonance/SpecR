import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getSpecPendingSummary: vi.fn(),
  getProjectPendingSummary: vi.fn(),
  SpecNotFoundError: class SpecNotFoundError extends Error {},
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const SPEC_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const PACKAGE_ID = '00000000-0000-4000-8000-000000000003';

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, query: {}, ...overrides } as unknown as Request;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('pending-summary API — spec scope', () => {
  it('rejects a malformed spec id at the boundary', async () => {
    const { getSpecPendingSummaryHandler } = await import('./pending-summary.js');
    const { getSpecPendingSummary } = await import('../db/index.js');
    const res = makeRes();

    await getSpecPendingSummaryHandler(
      makeReq({ params: { id: 'nope' } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getSpecPendingSummary).not.toHaveBeenCalled();
  });

  it('maps SpecNotFoundError to 404', async () => {
    const { getSpecPendingSummaryHandler } = await import('./pending-summary.js');
    const { getSpecPendingSummary, SpecNotFoundError } = await import('../db/index.js');
    vi.mocked(getSpecPendingSummary).mockRejectedValueOnce(
      new SpecNotFoundError(`spec ${SPEC_ID} not found`)
    );
    const res = makeRes();

    await getSpecPendingSummaryHandler(
      makeReq({ params: { id: SPEC_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns the summary on success', async () => {
    const { getSpecPendingSummaryHandler } = await import('./pending-summary.js');
    const { getSpecPendingSummary } = await import('../db/index.js');
    const summary = {
      specId: SPEC_ID,
      sealedByCheckpointId: null,
      sealedContentVersion: null,
      currentContentVersion: 3,
      changedParagraphCount: 2,
      actorRollup: [],
    };
    vi.mocked(getSpecPendingSummary).mockResolvedValueOnce(summary);
    const res = makeRes();

    await getSpecPendingSummaryHandler(
      makeReq({ params: { id: SPEC_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: summary });
  });

  it('logs and returns 500 on an unexpected failure', async () => {
    const { getSpecPendingSummaryHandler } = await import('./pending-summary.js');
    const { getSpecPendingSummary } = await import('../db/index.js');
    const { logger } = await import('../lib/logger.js');
    const err = new Error('connection lost');
    vi.mocked(getSpecPendingSummary).mockRejectedValueOnce(err);
    const res = makeRes();

    await getSpecPendingSummaryHandler(
      makeReq({ params: { id: SPEC_ID } }),
      res as unknown as Response
    );

    expect(logger.error).toHaveBeenCalledWith({ err }, 'get spec pending summary failed');
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('pending-summary API — project scope', () => {
  it('rejects a malformed packageId query param', async () => {
    const { getProjectPendingSummaryHandler } = await import('./pending-summary.js');
    const { getProjectPendingSummary } = await import('../db/index.js');
    const res = makeRes();

    await getProjectPendingSummaryHandler(
      makeReq({ params: { id: PROJECT_ID }, query: { packageId: 'nope' } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getProjectPendingSummary).not.toHaveBeenCalled();
  });

  it('passes an omitted packageId through as undefined, never scoping the query', async () => {
    const { getProjectPendingSummaryHandler } = await import('./pending-summary.js');
    const { getProjectPendingSummary } = await import('../db/index.js');
    vi.mocked(getProjectPendingSummary).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      packageId: null,
      changedSpecCount: 0,
      changedParagraphCount: 0,
      actorRollup: [],
      perSpec: [],
    });
    const res = makeRes();

    await getProjectPendingSummaryHandler(
      makeReq({ params: { id: PROJECT_ID } }),
      res as unknown as Response
    );

    expect(getProjectPendingSummary).toHaveBeenCalledWith(PROJECT_ID, undefined);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('threads a valid packageId through for the caller framing hint', async () => {
    const { getProjectPendingSummaryHandler } = await import('./pending-summary.js');
    const { getProjectPendingSummary } = await import('../db/index.js');
    vi.mocked(getProjectPendingSummary).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      packageId: PACKAGE_ID,
      changedSpecCount: 0,
      changedParagraphCount: 0,
      actorRollup: [],
      perSpec: [],
    });
    const res = makeRes();

    await getProjectPendingSummaryHandler(
      makeReq({ params: { id: PROJECT_ID }, query: { packageId: PACKAGE_ID } }),
      res as unknown as Response
    );

    expect(getProjectPendingSummary).toHaveBeenCalledWith(PROJECT_ID, PACKAGE_ID);
  });

  it('maps ProjectNotFoundError to 404', async () => {
    const { getProjectPendingSummaryHandler } = await import('./pending-summary.js');
    const { getProjectPendingSummary, ProjectNotFoundError } = await import('../db/index.js');
    vi.mocked(getProjectPendingSummary).mockRejectedValueOnce(
      new ProjectNotFoundError(`project ${PROJECT_ID} not found`)
    );
    const res = makeRes();

    await getProjectPendingSummaryHandler(
      makeReq({ params: { id: PROJECT_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
