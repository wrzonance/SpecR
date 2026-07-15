// Library-onboarding API-client method tests (#305 task 2/7). No live
// API/DB: every fetch call is a mocked `fetchImpl` injected via
// RequestContext, so these run fully offline and fast — same pattern as
// client.test.ts.

import { describe, expect, it, vi } from 'vitest';
import { VerifyApiError } from '../errors.js';
import {
  createClientLibrary,
  importLibraryMaster,
  waitForLibraryImportJob,
} from './library-client.js';
import type { RequestContext } from './http.js';

const BASE_URL = 'http://localhost:3000';
const LIBRARY_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';

function ctxWith(fetchImpl: typeof fetch, timeoutMs = 30_000): RequestContext {
  return { baseUrl: BASE_URL, fetchImpl, timeoutMs };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const validOnboardingResult = {
  specId: '44444444-4444-4444-8444-444444444444',
  section: '07 92 00',
  title: 'Joint Sealants',
  libraryId: LIBRARY_ID,
  templateId: '33333333-3333-4333-8333-333333333333',
  report: {
    styleDerivation: { nodeTypes: [], skippedNodeTypes: [], vanishSkipped: 0 },
    styleSourceNeeded: false,
    headerFooter: null,
    editability: { counts: { locked: 0, editable: 0, choice: 0, note: 0 }, lowConfidence: [] },
    hierarchy: { counts: { scored: 0, unscored: 0, belowThreshold: 0 }, lowConfidence: [] },
    parseWarnings: [],
  },
};

describe('createClientLibrary', () => {
  it('returns the created library id on a well-formed 201', async () => {
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/libraries/clients`);
      expect(init?.method).toBe('POST');
      return Promise.resolve(
        jsonResponse(201, { success: true, data: { id: LIBRARY_ID, name: 'Acme Client' } })
      );
    });

    const result = await createClientLibrary(ctxWith(fetchImpl), 'Acme Client');

    expect(result).toEqual({ id: LIBRARY_ID });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('throws VerifyApiError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(422, { success: false, error: 'name already in use' }))
    );

    await expect(createClientLibrary(ctxWith(fetchImpl), 'Acme Client')).rejects.toThrow(
      /422.*name already in use/
    );
  });

  it('throws VerifyApiError when the 2xx body does not match the expected shape', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(201, { success: true, data: { oops: true } }))
    );

    await expect(createClientLibrary(ctxWith(fetchImpl), 'Acme Client')).rejects.toMatchObject({
      stage: 'upload',
    });
  });
});

describe('importLibraryMaster', () => {
  function docxBuffer(): Buffer {
    return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  }

  it('uploads the file as a Blob typed DOCX_MIME and returns the jobId', async () => {
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/libraries/${LIBRARY_ID}/import`);
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      expect(file.type).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      return Promise.resolve(jsonResponse(202, { success: true, data: { jobId: JOB_ID } }));
    });

    const jobId = await importLibraryMaster(
      ctxWith(fetchImpl),
      LIBRARY_ID,
      docxBuffer(),
      'reference.docx'
    );

    expect(jobId).toBe(JOB_ID);
  });

  it('throws VerifyApiError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { success: false, error: 'library not found' }))
    );

    await expect(
      importLibraryMaster(ctxWith(fetchImpl), LIBRARY_ID, docxBuffer(), 'reference.docx')
    ).rejects.toThrow(/404.*library not found/);
  });
});

describe('waitForLibraryImportJob polls its own OnboardingStage terminal states', () => {
  const runningJob = {
    jobId: JOB_ID,
    status: 'running',
    progress: { stage: 'running', pct: 40 },
    expiresAt: 1_700_000_000_000,
  };
  const completeJob = {
    jobId: JOB_ID,
    status: 'complete',
    progress: { stage: 'complete', pct: 100 },
    result: validOnboardingResult,
    expiresAt: 1_700_000_000_000,
  };
  const failedJob = {
    jobId: JOB_ID,
    status: 'failed',
    progress: { stage: 'failed', pct: 0 },
    error: 'onboarding blew up',
    expiresAt: 1_700_000_000_000,
  };

  it('polls through running states and returns the result once complete', async () => {
    const sequence = [runningJob, runningJob, completeJob];
    let call = 0;
    const fetchImpl = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/libraries/import/jobs/${JOB_ID}`);
      expect(init?.method).toBe('GET');
      const job = sequence[call] ?? completeJob;
      call += 1;
      return Promise.resolve(jsonResponse(200, { success: true, data: job }));
    });

    const result = await waitForLibraryImportJob(ctxWith(fetchImpl), JOB_ID, {
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(result).toEqual(validOnboardingResult);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws VerifyApiError carrying the API error when the job fails', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: failedJob }))
    );

    await expect(
      waitForLibraryImportJob(ctxWith(fetchImpl), JOB_ID, { pollIntervalMs: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/failed: onboarding blew up/);
  });

  it('throws VerifyApiError when the job never completes before the deadline', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: runningJob }))
    );

    await expect(
      waitForLibraryImportJob(ctxWith(fetchImpl), JOB_ID, { pollIntervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow(/did not complete within/);
  });

  it('throws VerifyApiError when a complete job somehow carries no result', async () => {
    const bareCompleteJob = {
      jobId: JOB_ID,
      status: 'complete',
      progress: { stage: 'complete', pct: 100 },
      expiresAt: 1_700_000_000_000,
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: bareCompleteJob }))
    );

    await expect(waitForLibraryImportJob(ctxWith(fetchImpl), JOB_ID)).rejects.toThrow(
      VerifyApiError
    );
  });
});
