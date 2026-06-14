import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  pool: {},
  deleteReference: vi.fn(),
  findProjectById: vi.fn(),
  getInboundReferences: vi.fn(),
  getOutboundReferences: vi.fn(),
  isSpecInProject: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const SPEC_ID = '10000000-0000-4000-8000-000000000002';

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('getInboundReferencesHandler', () => {
  it('rejects malformed section before any DB call', async () => {
    const db = await import('../db/index.js');
    const { getInboundReferencesHandler } = await import('./references.js');
    const req = {
      params: { id: PROJECT_ID },
      query: { section: '9 91 00' },
    } as unknown as Request;
    const res = makeRes();

    await getInboundReferencesHandler(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(vi.mocked(db.findProjectById)).not.toHaveBeenCalled();
    expect(vi.mocked(db.getInboundReferences)).not.toHaveBeenCalled();
  });

  it('returns 404 when project is unknown', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findProjectById).mockResolvedValueOnce(null);
    const { getInboundReferencesHandler } = await import('./references.js');
    const req = {
      params: { id: PROJECT_ID },
      query: { section: '09 91 00' },
    } as unknown as Request;
    const res = makeRes();

    await getInboundReferencesHandler(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(vi.mocked(db.getInboundReferences)).not.toHaveBeenCalled();
  });
});

describe('getOutboundReferencesHandler', () => {
  it('returns 404 when spec is not in the project', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findProjectById).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      name: 'Project',
      description: null,
      sectionNumberFormat: 'canonical',
      sources: [],
      toc: [],
    });
    vi.mocked(db.isSpecInProject).mockResolvedValueOnce(false);
    const { getOutboundReferencesHandler } = await import('./references.js');
    const req = {
      params: { id: PROJECT_ID, specId: SPEC_ID },
      query: {},
    } as unknown as Request;
    const res = makeRes();

    await getOutboundReferencesHandler(req, res as unknown as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(vi.mocked(db.getOutboundReferences)).not.toHaveBeenCalled();
  });
});
