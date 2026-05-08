import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { errorHandler } from './error.js';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('errorHandler middleware', () => {
  const mockNext = vi.fn() as unknown as NextFunction;

  const makeRes = () => {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    return { res: { status, json } as unknown as Response, status, json };
  };

  it('returns 500 when err has no status', () => {
    const { res, status, json } = makeRes();
    errorHandler(new Error('boom'), {} as Request, res, mockNext);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'internal server error' });
  });

  it('uses err.status when present', () => {
    const { res, status, json } = makeRes();
    const err = Object.assign(new Error('not found'), { status: 404 });
    errorHandler(err, {} as Request, res, mockNext);
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'internal server error' });
  });
});
