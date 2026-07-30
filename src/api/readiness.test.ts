import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getReadinessReport: vi.fn(),
  SpecNotFoundError: class SpecNotFoundError extends Error {},
  PackageNotFoundError: class PackageNotFoundError extends Error {},
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

// Review finding (#406): readiness.integration.test.ts pins the 400/404/200
// paths of the ADR-079 dry-run endpoints over a real HTTP+DB round trip, but
// none of those cases can force getReadinessReport to reject with something
// other than SpecNotFoundError/PackageNotFoundError — that requires mocking
// the DB layer directly. Mirrors open-comments.test.ts's exact isolation
// pattern (its sibling module, same shared handle/mapError shape) to pin the
// one branch that precedent already proved needs its own unit test: mapError
// logs the original error before returning the generic 500, rather than
// leaking internals or dropping the failure with no server-side record.
describe('readiness API errors', () => {
  it('logs unexpected report failures before returning the generic 500 response', async () => {
    const err = new Error('connection lost');
    const { getReadinessReport } = await import('../db/index.js');
    vi.mocked(getReadinessReport).mockRejectedValueOnce(err);
    const { logger } = await import('../lib/logger.js');
    const { getSpecReadinessHandler } = await import('./readiness.js');

    const req = {
      params: { id: '00000000-0000-4000-8000-000000000001' },
    } as unknown as Request;
    const res = makeRes();

    await getSpecReadinessHandler(req, res as unknown as Response);

    expect(logger.error).toHaveBeenCalledWith({ err }, 'readiness report failed');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'readiness report failed',
    });
  });
});
