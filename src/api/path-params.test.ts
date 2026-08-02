import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { parsePathUuid } from './path-params.js';

// Mirrors readiness-guard.test.ts's mockRes() convention.
function mockRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

function mockReq(params: Record<string, string | undefined>): Request {
  return { params } as unknown as Request;
}

describe('parsePathUuid', () => {
  it('returns the value and writes nothing on a valid uuid (default paramName)', () => {
    const uuid = randomUUID();
    const res = mockRes();

    const id = parsePathUuid(mockReq({ id: uuid }), res, 'project id');

    expect(id).toBe(uuid);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('writes 400 {success:false, error:"invalid <label>"} and returns null when the param is missing', () => {
    const res = mockRes();

    const id = parsePathUuid(mockReq({}), res, 'package id');

    expect(id).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'invalid package id' });
  });

  it('writes the same 400 shape and returns null on a malformed (non-uuid) value', () => {
    const res = mockRes();

    const id = parsePathUuid(mockReq({ id: 'not-a-uuid' }), res, 'revision id');

    expect(id).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'invalid revision id' });
  });

  it('reads a custom paramName instead of "id"', () => {
    const uuid = randomUUID();
    const res = mockRes();

    const id = parsePathUuid(mockReq({ id: uuid, specId: 'not-a-uuid' }), res, 'spec id', 'specId');

    expect(id).toBeNull();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'invalid spec id' });
  });

  it('accepts a valid uuid on a custom paramName and returns it', () => {
    const uuid = randomUUID();
    const res = mockRes();

    const id = parsePathUuid(mockReq({ specId: uuid }), res, 'spec id', 'specId');

    expect(id).toBe(uuid);
    expect(res.status).not.toHaveBeenCalled();
  });
});
