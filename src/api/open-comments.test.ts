import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getOpenCommentsReport: vi.fn(),
  SpecNotFoundError: class SpecNotFoundError extends Error {},
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('open-comments API errors', () => {
  it('logs unexpected report failures before returning the generic 500 response', async () => {
    const err = new Error('connection lost');
    const { getOpenCommentsReport } = await import('../db/index.js');
    vi.mocked(getOpenCommentsReport).mockRejectedValueOnce(err);
    const { logger } = await import('../lib/logger.js');
    const { getSpecOpenCommentsHandler } = await import('./open-comments.js');

    const req = {
      params: { id: '00000000-0000-4000-8000-000000000001' },
    } as unknown as Request;
    const res = makeRes();

    await getSpecOpenCommentsHandler(req, res as unknown as Response);

    expect(logger.error).toHaveBeenCalledWith({ err }, 'open-comments report failed');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'open-comments report failed',
    });
  });
});
