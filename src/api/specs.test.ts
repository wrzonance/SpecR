import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

vi.mock('../db/index.js', () => ({
  getSpecTree: vi.fn(),
  updateSpec: vi.fn(),
  getSpecLineage: vi.fn(),
  getSpecStyleSource: vi.fn(),
  getOnboardingStatus: vi.fn(),
  getSpecWithdrawnAt: vi.fn(),
  withdrawSpec: vi.fn(),
  restoreSpec: vi.fn(),
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
});

describe('getSpecHandler', () => {
  it('returns 200 with reconstructed SpecTree, styleSource, onboardingStatus and withdrawnAt when spec exists', async () => {
    const { getSpecTree, getSpecStyleSource, getOnboardingStatus, getSpecWithdrawnAt } =
      await import('../db/index.js');
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: {
        id: 'abc',
        section: '27 21 00',
        title: 'Cabling',
        parts: [
          {
            id: 'p1',
            type: 'part',
            text: 'PART 1 - GENERAL',
            children: [],
            meta: {},
          },
        ],
      },
      references: [],
    });
    vi.mocked(getSpecStyleSource).mockResolvedValueOnce({
      templateId: 'tpl-1',
      templateName: 'House Style',
    });
    vi.mocked(getOnboardingStatus).mockResolvedValueOnce('active');
    vi.mocked(getSpecWithdrawnAt).mockResolvedValueOnce('2026-06-27T00:00:00.000Z');
    const { getSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'abc' } } as unknown as Request;
    const res = makeRes();
    await getSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['success']).toBe(true);
    const data = body['data'] as Record<string, unknown>;
    expect(data['id']).toBe('abc');
    // regression #152: handler must return the reconstructed tree, not parts: []
    expect((data['parts'] as unknown[]).length).toBe(1);
    // #138: style-source association surfaces as a sibling field on the tree
    expect(data['styleSource']).toEqual({ templateId: 'tpl-1', templateName: 'House Style' });
    // #139: onboarding status surfaces as a sibling field on the tree
    expect(data['onboardingStatus']).toBe('active');
    // ADR-030: a withdrawn master surfaces its tombstone here (GET stays resolvable)
    expect(data['withdrawnAt']).toBe('2026-06-27T00:00:00.000Z');
  });

  it('returns 200 with styleSource and withdrawnAt null when spec has no style template / is active', async () => {
    const { getSpecTree, getSpecStyleSource, getOnboardingStatus, getSpecWithdrawnAt } =
      await import('../db/index.js');
    vi.mocked(getSpecTree).mockResolvedValueOnce({
      tree: { id: 'abc', section: '27 21 00', title: 'Cabling', parts: [] },
      references: [],
    });
    vi.mocked(getSpecStyleSource).mockResolvedValueOnce(null);
    vi.mocked(getOnboardingStatus).mockResolvedValueOnce('review');
    vi.mocked(getSpecWithdrawnAt).mockResolvedValueOnce(null);
    const { getSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'abc' } } as unknown as Request;
    const res = makeRes();
    await getSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['styleSource']).toBeNull();
    expect((body['data'] as Record<string, unknown>)['onboardingStatus']).toBe('review');
    expect((body['data'] as Record<string, unknown>)['withdrawnAt']).toBeNull();
  });

  it('returns 404 when spec not found', async () => {
    const { getSpecTree } = await import('../db/index.js');
    vi.mocked(getSpecTree).mockResolvedValueOnce(null);
    const { getSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'missing' } } as unknown as Request;
    const res = makeRes();
    await getSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('spec not found');
  });

  it('returns 500 on database error', async () => {
    const { getSpecTree } = await import('../db/index.js');
    vi.mocked(getSpecTree).mockRejectedValueOnce(new Error('db down'));
    const { getSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'abc' } } as unknown as Request;
    const res = makeRes();
    await getSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 400 when id param is missing', async () => {
    const { getSpecHandler } = await import('./specs.js');
    const req = { params: {} } as unknown as Request;
    const res = makeRes();
    await getSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('missing spec id');
  });
});

describe('updateSpecHandler', () => {
  it('returns 200 with SpecSummary when update succeeds', async () => {
    const { updateSpec } = await import('../db/index.js');
    vi.mocked(updateSpec).mockResolvedValueOnce({
      specId: 'abc',
      title: 'New Title',
      section: '27 21 00',
    });
    const { updateSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'abc' }, body: { title: 'New Title' } } as unknown as Request;
    const res = makeRes();
    await updateSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['title']).toBe('New Title');
  });

  it('returns 404 when spec not found', async () => {
    const { updateSpec } = await import('../db/index.js');
    vi.mocked(updateSpec).mockResolvedValueOnce(null);
    const { updateSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'missing' }, body: { title: 'x' } } as unknown as Request;
    const res = makeRes();
    await updateSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 500 on database error', async () => {
    const { updateSpec } = await import('../db/index.js');
    vi.mocked(updateSpec).mockRejectedValueOnce(new Error('db down'));
    const { updateSpecHandler } = await import('./specs.js');
    const req = { params: { id: 'abc' }, body: {} } as unknown as Request;
    const res = makeRes();
    await updateSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 400 when id param is missing', async () => {
    const { updateSpecHandler } = await import('./specs.js');
    const req = { params: {}, body: { title: 'x' } } as unknown as Request;
    const res = makeRes();
    await updateSpecHandler(req, res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['error']).toBe('missing spec id');
  });
});

const VALID_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('withdrawSpecHandler', () => {
  it('returns 200 with {specId, withdrawnAt} on a master', async () => {
    const { withdrawSpec } = await import('../db/index.js');
    vi.mocked(withdrawSpec).mockResolvedValueOnce({
      kind: 'withdrawn',
      specId: VALID_ID,
      withdrawnAt: '2026-06-27T00:00:00.000Z',
    });
    const { withdrawSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await withdrawSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json.mock.calls[0]?.[0] as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    expect(data['specId']).toBe(VALID_ID);
    expect(data['withdrawnAt']).toBe('2026-06-27T00:00:00.000Z');
  });

  it('returns 409 on a project copy', async () => {
    const { withdrawSpec } = await import('../db/index.js');
    vi.mocked(withdrawSpec).mockResolvedValueOnce({ kind: 'project-copy' });
    const { withdrawSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await withdrawSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 when unknown', async () => {
    const { withdrawSpec } = await import('../db/index.js');
    vi.mocked(withdrawSpec).mockResolvedValueOnce({ kind: 'not-found' });
    const { withdrawSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await withdrawSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 on a malformed (non-UUID) id', async () => {
    const { withdrawSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await withdrawSpecHandler(
      { params: { id: 'nope' } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 500 on database error', async () => {
    const { withdrawSpec } = await import('../db/index.js');
    vi.mocked(withdrawSpec).mockRejectedValueOnce(new Error('db down'));
    const { withdrawSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await withdrawSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('restoreSpecHandler', () => {
  it('returns 200 with {specId} on a master', async () => {
    const { restoreSpec } = await import('../db/index.js');
    vi.mocked(restoreSpec).mockResolvedValueOnce({ kind: 'restored', specId: VALID_ID });
    const { restoreSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await restoreSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const data = (res.json.mock.calls[0]?.[0] as Record<string, unknown>)['data'] as Record<
      string,
      unknown
    >;
    expect(data['specId']).toBe(VALID_ID);
  });

  it('returns 409 on a project copy', async () => {
    const { restoreSpec } = await import('../db/index.js');
    vi.mocked(restoreSpec).mockResolvedValueOnce({ kind: 'project-copy' });
    const { restoreSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await restoreSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('returns 404 when unknown', async () => {
    const { restoreSpec } = await import('../db/index.js');
    vi.mocked(restoreSpec).mockResolvedValueOnce({ kind: 'not-found' });
    const { restoreSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await restoreSpecHandler(
      { params: { id: VALID_ID } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 400 on a malformed (non-UUID) id', async () => {
    const { restoreSpecHandler } = await import('./specs.js');
    const res = makeRes();
    await restoreSpecHandler(
      { params: { id: 'nope' } } as unknown as Request,
      res as unknown as Response
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
