import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// Mock the db module
vi.mock('../db/index.js', () => ({
  pool: {},
  pingDatabase: vi.fn(),
}));

// Mock logger to avoid pino-pretty in tests
vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('healthHandler', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let statusSpy: ReturnType<typeof vi.fn>;
  let jsonSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    jsonSpy = vi.fn();
    statusSpy = vi.fn().mockReturnValue({ json: jsonSpy });
    mockReq = {};
    mockRes = {
      status: statusSpy as unknown as Response['status'],
      json: jsonSpy as unknown as Response['json'],
    };
  });

  it('returns 200 with db connected when ping succeeds', async () => {
    const { pingDatabase } = await import('../db/index.js');
    vi.mocked(pingDatabase).mockResolvedValueOnce(undefined);
    const { healthHandler } = await import('./health.js');

    await healthHandler(mockReq as Request, mockRes as Response);

    expect(statusSpy).toHaveBeenCalledWith(200);
    const jsonArg = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg['success']).toBe(true);
    expect((jsonArg['data'] as Record<string, unknown>)['db']).toBe('connected');
    expect(typeof (jsonArg['data'] as Record<string, unknown>)['uptime']).toBe('number');
  });

  it('returns 503 with error when ping fails', async () => {
    const { pingDatabase } = await import('../db/index.js');
    vi.mocked(pingDatabase).mockRejectedValueOnce(new Error('connection refused'));
    const { healthHandler } = await import('./health.js');

    await healthHandler(mockReq as Request, mockRes as Response);

    expect(statusSpy).toHaveBeenCalledWith(503);
    const jsonArg = jsonSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(jsonArg['success']).toBe(false);
    expect(jsonArg['error']).toBe('database unavailable');
  });
});
