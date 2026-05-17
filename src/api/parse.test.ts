import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../parser/index.js', () => ({
  parseSec: vi.fn(),
  parseDocx: vi.fn().mockResolvedValue({ id: '', section: 'test', title: 'T', parts: [] }),
  assertDocxSafe: vi.fn().mockResolvedValue(undefined),
  assertSecSafe: vi.fn(),
}));
vi.mock('../lib/parse-pool.js', () => ({
  parsePool: {
    run: vi.fn().mockResolvedValue({ tree: { id: '', section: 'test', title: 'T', parts: [] } }),
  },
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
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'file required' }));
  });

  it('returns 400 for unsupported file extension', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: { originalname: 'test.pdf', mimetype: 'application/pdf', buffer: Buffer.alloc(4) },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'unsupported file extension' })
    );
  });

  it('returns 400 for .docx with wrong MIME type', async () => {
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MIME type mismatch for .docx' })
    );
  });

  it('returns 400 and does NOT create a job when assertDocxSafe rejects', async () => {
    const { assertDocxSafe } = await import('../parser/index.js');
    vi.mocked(assertDocxSafe).mockRejectedValueOnce(new Error('macros not allowed'));
    const { createJob } = await import('../lib/jobs.js');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'macros not allowed' }));
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns 202 with jobId for a valid .docx upload', async () => {
    const { createJob } = await import('../lib/jobs.js');
    vi.mocked(createJob).mockReturnValue('test-job-id');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.docx',
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: { jobId: 'test-job-id' } })
    );
  });

  it('returns 202 for a valid .sec upload', async () => {
    const { createJob } = await import('../lib/jobs.js');
    vi.mocked(createJob).mockReturnValue('sec-job-id');
    const { parseHandler } = await import('./parse.js');
    const req = {
      file: {
        originalname: 'spec.sec',
        mimetype: 'text/xml',
        buffer: Buffer.from('<?xml?>', 'utf-8'),
      },
      body: {},
    } as unknown as Request;
    const res = makeRes();
    await parseHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(202);
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
