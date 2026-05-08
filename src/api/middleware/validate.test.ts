import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { validateBody } from './validate.js';

const schema = z.object({ name: z.string().check(z.minLength(1)) });

function makeRes(): {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

describe('validateBody', () => {
  it('calls next() when body is valid', () => {
    const middleware = validateBody(schema);
    const req = { body: { name: 'Alice' } } as Request;
    const { status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, { status } as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it('returns 422 when body is invalid', () => {
    const middleware = validateBody(schema);
    const req = { body: {} } as Request;
    const { status, json } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, { status } as unknown as Response, next);
    expect(status).toHaveBeenCalledWith(422);
    const body = json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(false);
    expect(body['error']).toBe('validation failed');
    expect(next).not.toHaveBeenCalled();
  });

  it('strips unknown keys from req.body on success', () => {
    const middleware = validateBody(schema);
    const req = { body: { name: 'Alice', extra: 'stripped' } } as Request;
    const { status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, { status } as unknown as Response, next);
    expect(req.body).toEqual({ name: 'Alice' });
  });

  it('returns 422 when body is null', () => {
    const middleware = validateBody(schema);
    const req = { body: null } as Request;
    const { status } = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    middleware(req, { status } as unknown as Response, next);
    expect(status).toHaveBeenCalledWith(422);
  });
});
