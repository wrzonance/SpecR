import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  pool: {},
  DatabaseError: class DatabaseError extends Error {
    cause?: unknown;
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DatabaseError';
      this.cause = options?.cause;
    }
  },
  createProject: vi.fn(),
  findProjectById: vi.fn(),
  addSpecToProject: vi.fn(),
  removeSpecFromProject: vi.fn(),
  getBrokenRefs: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function makeRes(): { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json };
}

beforeEach(() => {
  vi.resetModules();
});

describe('createProjectHandler', () => {
  it('returns 201 with ProjectSummary on success', async () => {
    const { createProject } = await import('../db/index.js');
    vi.mocked(createProject).mockResolvedValueOnce({
      projectId: 'p1',
      name: 'Test',
      description: null,
    });
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test' } } as unknown as Request;
    const res = makeRes();
    await createProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(true);
    expect((body['data'] as Record<string, unknown>)['projectId']).toBe('p1');
  });

  it('returns 500 on database error', async () => {
    const { createProject } = await import('../db/index.js');
    vi.mocked(createProject).mockRejectedValueOnce(new Error('db down'));
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test' } } as unknown as Request;
    const res = makeRes();
    await createProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('getProjectHandler', () => {
  it('returns 200 with project when found', async () => {
    const { findProjectById } = await import('../db/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce({
      projectId: 'p1',
      name: 'Test',
      description: null,
      toc: [],
    });
    const { getProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' } } as unknown as Request;
    const res = makeRes();
    await getProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(true);
  });

  it('returns 404 when project not found', async () => {
    const { findProjectById } = await import('../db/index.js');
    vi.mocked(findProjectById).mockResolvedValueOnce(null);
    const { getProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'missing' } } as unknown as Request;
    const res = makeRes();
    await getProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('project not found');
  });

  it('returns 400 when id param missing', async () => {
    const { getProjectHandler } = await import('./projects.js');
    const req = { params: {} } as unknown as Request;
    const res = makeRes();
    await getProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 500 on database error', async () => {
    const { findProjectById } = await import('../db/index.js');
    vi.mocked(findProjectById).mockRejectedValueOnce(new Error('db down'));
    const { getProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' } } as unknown as Request;
    const res = makeRes();
    await getProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('addSpecToProjectHandler', () => {
  it('returns 201 with AddSpecResult on success', async () => {
    const { addSpecToProject } = await import('../db/index.js');
    vi.mocked(addSpecToProject).mockResolvedValueOnce({ specId: 's1', position: 1 });
    const { addSpecToProjectHandler } = await import('./projects.js');
    const req = {
      params: { id: 'p1' },
      body: { specId: 's1' },
    } as unknown as Request;
    const res = makeRes();
    await addSpecToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['position']).toBe(1);
  });

  it('returns 409 on duplicate spec (pg 23505)', async () => {
    const { addSpecToProject, DatabaseError } = await import('../db/index.js');
    const cause = Object.assign(new Error('unique'), { code: '23505' });
    vi.mocked(addSpecToProject).mockRejectedValueOnce(
      new (DatabaseError as new (m: string, o?: ErrorOptions) => Error)('dup', { cause })
    );
    const { addSpecToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { specId: 's1' } } as unknown as Request;
    const res = makeRes();
    await addSpecToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('spec already in project');
  });

  it('returns 404 on FK violation (pg 23503)', async () => {
    const { addSpecToProject, DatabaseError } = await import('../db/index.js');
    const cause = Object.assign(new Error('fk'), { code: '23503' });
    vi.mocked(addSpecToProject).mockRejectedValueOnce(
      new (DatabaseError as new (m: string, o?: ErrorOptions) => Error)('fk', { cause })
    );
    const { addSpecToProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' }, body: { specId: 's1' } } as unknown as Request;
    const res = makeRes();
    await addSpecToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 when id param missing', async () => {
    const { addSpecToProjectHandler } = await import('./projects.js');
    const req = { params: {}, body: { specId: 's1' } } as unknown as Request;
    const res = makeRes();
    await addSpecToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('removeSpecFromProjectHandler', () => {
  it('returns 200 on successful removal', async () => {
    const { removeSpecFromProject } = await import('../db/index.js');
    vi.mocked(removeSpecFromProject).mockResolvedValueOnce(true);
    const { removeSpecFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1', specId: 's1' } } as unknown as Request;
    const res = makeRes();
    await removeSpecFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 404 when spec not in project', async () => {
    const { removeSpecFromProject } = await import('../db/index.js');
    vi.mocked(removeSpecFromProject).mockResolvedValueOnce(false);
    const { removeSpecFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1', specId: 's1' } } as unknown as Request;
    const res = makeRes();
    await removeSpecFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('spec not in project');
  });

  it('returns 400 when specId param missing', async () => {
    const { removeSpecFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' } } as unknown as Request;
    const res = makeRes();
    await removeSpecFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('getBrokenRefsHandler', () => {
  it('returns 200 with broken refs', async () => {
    const { getBrokenRefs } = await import('../db/index.js');
    vi.mocked(getBrokenRefs).mockResolvedValueOnce([
      {
        refId: 'r1',
        sourceSpecId: 's1',
        sourceSpecSection: '03 30 00',
        targetSpecSection: '09 91 00',
        referenceText: 'See Section 09 91 00',
      },
    ]);
    const { getBrokenRefsHandler } = await import('./projects.js');
    const req = { params: { id: 'p1' } } as unknown as Request;
    const res = makeRes();
    await getBrokenRefsHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Array.isArray(body['data'])).toBe(true);
    expect((body['data'] as unknown[]).length).toBe(1);
  });

  it('returns 400 when id param missing', async () => {
    const { getBrokenRefsHandler } = await import('./projects.js');
    const req = { params: {} } as unknown as Request;
    const res = makeRes();
    await getBrokenRefsHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
