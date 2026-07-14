import { describe, it, expect, vi } from 'vitest';
import multer from 'multer';
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

  it('returns 400 for MulterError', () => {
    const { res, status, json } = makeRes();
    const err = new multer.MulterError('LIMIT_FILE_SIZE');
    errorHandler(err, {} as Request, res, mockNext);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ success: false, error: err.message });
  });

  it('returns 413 with a non-leaky message for body-parser payload-too-large errors', () => {
    const { res, status, json } = makeRes();
    const err = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
      limit: 102400,
      length: 204800,
    });
    errorHandler(err, {} as Request, res, mockNext);
    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'payload too large' });
  });
});
