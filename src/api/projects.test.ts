import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// path-params.ts validates path ids with z.uuid() (#568) — these fixture ids
// must be well-formed uuids (not the old "p1"/"s1" placeholders) or every
// handler under test would 400 before its mocked db call ever runs.
const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPEC_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  InvalidSourceLibraryError: class InvalidSourceLibraryError extends Error {},
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
  SectionUnresolvedError: class SectionUnresolvedError extends Error {},
  createProject: vi.fn(),
  findProjectById: vi.fn(),
  addSectionToProject: vi.fn(),
  removeSectionFromProject: vi.fn(),
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
      clientId: null,
      clientName: null,
      sources: [],
    });
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test', sourceLibraryIds: ['lib-1'] } } as unknown as Request;
    const res = makeRes();
    await createProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(true);
    expect((body['data'] as Record<string, unknown>)['projectId']).toBe('p1');
  });

  it('returns 422 when a source library is invalid', async () => {
    const { createProject, InvalidSourceLibraryError } = await import('../db/index.js');
    vi.mocked(createProject).mockRejectedValueOnce(
      new (InvalidSourceLibraryError as new (m: string) => Error)('bad tier')
    );
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test', sourceLibraryIds: ['lib-ref'] } } as unknown as Request;
    const res = makeRes();
    await createProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('returns 500 on database error', async () => {
    const { createProject } = await import('../db/index.js');
    vi.mocked(createProject).mockRejectedValueOnce(new Error('db down'));
    const { createProjectHandler } = await import('./projects.js');
    const req = { body: { name: 'Test', sourceLibraryIds: ['lib-1'] } } as unknown as Request;
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
      sources: [],
      toc: [],
      deletedAt: null,
      deletedBy: null,
      sectionNumberFormat: 'canonical',
    });
    const { getProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID } } as unknown as Request;
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
    const req = { params: { id: PROJECT_ID } } as unknown as Request;
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
    const req = { params: { id: PROJECT_ID } } as unknown as Request;
    const res = makeRes();
    await getProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('addSectionToProjectHandler', () => {
  it('returns 201 with AddSectionResult on success', async () => {
    const { addSectionToProject } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockResolvedValueOnce({
      specId: 'clone-1',
      section: '03 30 00',
      position: 1,
      source: { libraryId: 'lib-1', name: 'Co M' },
    });
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(201);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['specId']).toBe('clone-1');
  });

  it('returns 404 for unknown project (ProjectNotFoundError)', async () => {
    const { addSectionToProject, ProjectNotFoundError } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (ProjectNotFoundError as new (m: string) => Error)('nope')
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 422 when no source holds the section (SectionUnresolvedError)', async () => {
    const { addSectionToProject, SectionUnresolvedError } = await import('../db/index.js');
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (SectionUnresolvedError as new (m: string) => Error)('unresolved')
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID }, body: { section: '99 99 99' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('returns 409 on duplicate section (pg 23505)', async () => {
    const { addSectionToProject, DatabaseError } = await import('../db/index.js');
    const cause = Object.assign(new Error('unique'), { code: '23505' });
    vi.mocked(addSectionToProject).mockRejectedValueOnce(
      new (DatabaseError as new (m: string, o?: ErrorOptions) => Error)('dup', { cause })
    );
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID }, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('section already in project');
  });

  it('returns 400 when id param missing', async () => {
    const { addSectionToProjectHandler } = await import('./projects.js');
    const req = { params: {}, body: { section: '03 30 00' } } as unknown as Request;
    const res = makeRes();
    await addSectionToProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('removeSectionFromProjectHandler', () => {
  it('returns 200 on removed', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('removed');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID, specId: SPEC_ID }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(vi.mocked(removeSectionFromProject)).toHaveBeenCalledWith(
      PROJECT_ID,
      SPEC_ID,
      false,
      {}
    );
  });

  it('returns 404 on not-found', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('not-found');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID, specId: SPEC_ID }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 409 on edited without force; force=true is forwarded', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('edited');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID, specId: SPEC_ID }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);

    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('removed');
    const req2 = {
      params: { id: PROJECT_ID, specId: SPEC_ID },
      query: { force: 'true' },
    } as unknown as Request;
    const res2 = makeRes();
    await removeSectionFromProjectHandler(req2, res2 as unknown as Response);
    expect(vi.mocked(removeSectionFromProject)).toHaveBeenLastCalledWith(
      PROJECT_ID,
      SPEC_ID,
      true,
      {}
    );
  });

  it('returns 409 on in-package (section belongs to a design package)', async () => {
    const { removeSectionFromProject } = await import('../db/index.js');
    vi.mocked(removeSectionFromProject).mockResolvedValueOnce('in-package');
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID, specId: SPEC_ID }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toContain('package');
  });

  it('returns 400 when specId param missing', async () => {
    const { removeSectionFromProjectHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID }, query: {} } as unknown as Request;
    const res = makeRes();
    await removeSectionFromProjectHandler(req, res as unknown as Response);
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
        sourceParagraphId: 'para-1',
        snippet: '…coordinate with See Section 09 91 00 for finishes…',
        targetSpecSection: '09 91 00',
        referenceText: 'See Section 09 91 00',
        availableFrom: [],
      },
    ]);
    const { getBrokenRefsHandler } = await import('./projects.js');
    const req = { params: { id: PROJECT_ID } } as unknown as Request;
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
