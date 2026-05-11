import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../parser/index.js', () => ({
  parseSec: vi.fn(),
  parseDocx: vi.fn().mockResolvedValue({ id: '', section: 'test', title: 'T', parts: [] }),
}));
vi.mock('../lib/jobs.js', () => ({
  createJob: vi.fn().mockReturnValue('test-job-id'),
  updateJob: vi.fn(),
  getJob: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  pool: { connect: vi.fn(), query: vi.fn() },
  createSpec: vi.fn(),
  insertTree: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): Response {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
});

describe('parseHandler', () => {
  it('returns 400 when no file uploaded', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = { file: undefined, body: {} } as Request;
    const res = makeRes();
    parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 202 with jobId when file provided', async () => {
    const { createJob } = await import('../lib/jobs.js');
    vi.mocked(createJob).mockReturnValue('test-job-id');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: { originalname: 'test.docx', buffer: Buffer.from('fake') },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { jobId: 'test-job-id' } })
    );
  });
});

describe('parseJobHandler', () => {
  it('returns 404 when job not found', async () => {
    const { getJob } = await import('../lib/jobs.js');
    vi.mocked(getJob).mockReturnValue(undefined);
    const { parseJobHandler } = await import('./parse.js');
    const req = { params: { jobId: 'nonexistent' } } as unknown as Request;
    const res = makeRes();
    parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 200 with job data when found', async () => {
    const { getJob } = await import('../lib/jobs.js');
    vi.mocked(getJob).mockReturnValue({
      jobId: 'abc',
      status: 'complete' as const,
      progress: { stage: 'complete' as const, pct: 100 },
      expiresAt: Date.now() + 3600000,
    });
    const { parseJobHandler } = await import('./parse.js');
    const req = { params: { jobId: 'abc' } } as unknown as Request;
    const res = makeRes();
    parseJobHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
