// Project-provisioning API-client method tests (#305 task 2/7). No live
// API/DB: every fetch call is a mocked `fetchImpl` injected via
// RequestContext, so these run fully offline and fast — same pattern as
// client.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { addSectionToProject, createProject, putProjectHeaderFooter } from './project-client.js';
import type { RequestContext } from './http.js';

const BASE_URL = 'http://localhost:3000';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const LIBRARY_ID = '11111111-1111-4111-8111-111111111111';

function ctxWith(fetchImpl: typeof fetch, timeoutMs = 30_000): RequestContext {
  return { baseUrl: BASE_URL, fetchImpl, timeoutMs };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const validProjectSummary = {
  projectId: PROJECT_ID,
  name: 'Campus Renovation',
  description: null,
  clientId: null,
  clientName: null,
  sources: [{ libraryId: LIBRARY_ID, name: 'Acme Client', tier: 'client', priority: 1 }],
};

describe('createProject', () => {
  it('returns the created projectId on a well-formed 201', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        name: 'Campus Renovation',
        sourceLibraryIds: [LIBRARY_ID],
      });
      return Promise.resolve(jsonResponse(201, { success: true, data: validProjectSummary }));
    });

    const result = await createProject(ctxWith(fetchImpl), 'Campus Renovation', [LIBRARY_ID]);

    expect(result).toEqual({ projectId: PROJECT_ID });
  });

  it('throws VerifyApiError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(422, { success: false, error: 'unknown library' }))
    );

    await expect(
      createProject(ctxWith(fetchImpl), 'Campus Renovation', [LIBRARY_ID])
    ).rejects.toThrow(/422.*unknown library/);
  });

  it('throws VerifyApiError when the 2xx body does not match ProjectSummary (e.g. legacy `id` field)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse(201, { success: true, data: { id: PROJECT_ID, name: 'Campus Renovation' } })
      )
    );

    await expect(
      createProject(ctxWith(fetchImpl), 'Campus Renovation', [LIBRARY_ID])
    ).rejects.toMatchObject({ stage: 'import' });
  });
});

describe('addSectionToProject', () => {
  const validResult = {
    specId: '55555555-5555-4555-8555-555555555555',
    section: '09 91 26',
    position: 1,
    source: { libraryId: LIBRARY_ID, name: 'Acme Client' },
  };

  it('returns the cloned spec on a well-formed 201', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({ section: '09 91 26' });
      return Promise.resolve(jsonResponse(201, { success: true, data: validResult }));
    });

    const result = await addSectionToProject(ctxWith(fetchImpl), PROJECT_ID, '09 91 26');

    expect(result).toEqual(validResult);
  });

  it('passes through a 409 (section already in project) as VerifyApiError', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(409, { success: false, error: 'section already in project' }))
    );

    await expect(addSectionToProject(ctxWith(fetchImpl), PROJECT_ID, '09 91 26')).rejects.toThrow(
      /409.*section already in project/
    );
  });

  it('throws VerifyApiError when the 2xx body is missing required fields', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(201, { success: true, data: { specId: validResult.specId } }))
    );

    await expect(
      addSectionToProject(ctxWith(fetchImpl), PROJECT_ID, '09 91 26')
    ).rejects.toMatchObject({ stage: 'import' });
  });
});

describe('putProjectHeaderFooter', () => {
  const validConfig = {
    id: '66666666-6666-4666-8666-666666666666',
    scope: { kind: 'project', projectId: PROJECT_ID },
    config: { pageNumbering: { mode: 'restartPerSpec', startAt: 1 } },
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };

  it('PUTs the composition body and returns the stored config', async () => {
    const composition = { pageNumbering: { mode: 'restartPerSpec' as const, startAt: 1 } };
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(init?.body as string)).toEqual(composition);
      return Promise.resolve(jsonResponse(200, { success: true, data: validConfig }));
    });

    const result = await putProjectHeaderFooter(ctxWith(fetchImpl), PROJECT_ID, composition);

    expect(result).toEqual(validConfig);
  });

  it('throws VerifyApiError on a 413 (payload too large)', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(413, { success: false, error: 'config too large' }))
    );

    await expect(putProjectHeaderFooter(ctxWith(fetchImpl), PROJECT_ID, {})).rejects.toThrow(
      /413.*config too large/
    );
  });

  it('throws VerifyApiError when the 2xx body has a flat projectId instead of a scope union', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          success: true,
          data: { id: validConfig.id, projectId: PROJECT_ID, config: {} },
        })
      )
    );

    await expect(putProjectHeaderFooter(ctxWith(fetchImpl), PROJECT_ID, {})).rejects.toMatchObject({
      stage: 'import',
    });
  });
});
