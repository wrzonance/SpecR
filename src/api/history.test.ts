import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getParagraphHistory: vi.fn(),
  getCoalescedParagraphHistory: vi.fn(),
  getSpecHistory: vi.fn(),
  getSpecHistoryDiff: vi.fn(),
  HistoryAnchorError: class HistoryAnchorError extends Error {},
}));

vi.mock('../lib/env.js', () => ({
  config: { HISTORY_SESSION_WINDOW_MS: 1_800_000 },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const SPEC_ID = '00000000-0000-4000-8000-000000000001';
const NODE_ID = '00000000-0000-4000-8000-000000000002';

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

describe('getParagraphHistoryHandler — raw/coalesced dispatch (#380 default flip)', () => {
  it('defaults to the coalesced tier-1 read when ?raw is absent', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getParagraphHistory, getCoalescedParagraphHistory } = await import('../db/index.js');
    vi.mocked(getCoalescedParagraphHistory).mockResolvedValueOnce([]);
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID } }),
      res as unknown as Response
    );

    expect(getCoalescedParagraphHistory).toHaveBeenCalledWith(SPEC_ID, NODE_ID, 1_800_000, false);
    expect(getParagraphHistory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('defaults to coalesced when ?raw=false explicitly', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getCoalescedParagraphHistory } = await import('../db/index.js');
    vi.mocked(getCoalescedParagraphHistory).mockResolvedValueOnce([]);
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, query: { raw: 'false' } }),
      res as unknown as Response
    );

    expect(getCoalescedParagraphHistory).toHaveBeenCalled();
  });

  it('returns tier-0 raw entries on ?raw=true, never calling the coalescer', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getParagraphHistory, getCoalescedParagraphHistory } = await import('../db/index.js');
    vi.mocked(getParagraphHistory).mockResolvedValueOnce([]);
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, query: { raw: 'true' } }),
      res as unknown as Response
    );

    expect(getParagraphHistory).toHaveBeenCalledWith(SPEC_ID, NODE_ID, false);
    expect(getCoalescedParagraphHistory).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('threads includeOrigin through to both the raw and coalesced paths', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getParagraphHistory, getCoalescedParagraphHistory } = await import('../db/index.js');
    vi.mocked(getParagraphHistory).mockResolvedValueOnce([]);
    vi.mocked(getCoalescedParagraphHistory).mockResolvedValueOnce([]);
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({
        params: { id: SPEC_ID, nodeId: NODE_ID },
        query: { raw: 'true', includeOrigin: 'true' },
      }),
      res as unknown as Response
    );
    expect(getParagraphHistory).toHaveBeenCalledWith(SPEC_ID, NODE_ID, true);

    await getParagraphHistoryHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID }, query: { includeOrigin: 'true' } }),
      res as unknown as Response
    );
    expect(getCoalescedParagraphHistory).toHaveBeenCalledWith(SPEC_ID, NODE_ID, 1_800_000, true);
  });

  it('returns 404 when the coalesced read finds no such spec/paragraph', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getCoalescedParagraphHistory } = await import('../db/index.js');
    vi.mocked(getCoalescedParagraphHistory).mockResolvedValueOnce(null);
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({ params: { id: SPEC_ID, nodeId: NODE_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejects a malformed spec or node id before touching the db', async () => {
    const { getParagraphHistoryHandler } = await import('./history.js');
    const { getCoalescedParagraphHistory } = await import('../db/index.js');
    const res = makeRes();

    await getParagraphHistoryHandler(
      makeReq({ params: { id: 'nope', nodeId: NODE_ID } }),
      res as unknown as Response
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getCoalescedParagraphHistory).not.toHaveBeenCalled();
  });
});
