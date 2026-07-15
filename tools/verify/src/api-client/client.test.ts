// API client invariant tests (#150, task 3/8). No live API/DB: every fetch
// call is a mocked `fetchImpl` injected via ApiClientConfig, so these run
// fully offline and fast.

import { describe, expect, it, vi } from 'vitest';
import { createApiClient, DOCX_MIME, templateNameForRun } from './client.js';
import { VerifyApiError, VerifyValidationError } from '../errors.js';

const BASE_URL = 'http://localhost:3000';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function docxBuffer(): Buffer {
  // Minimal zip local-file-header signature + filler — enough to pass the
  // zip-magic check without being a real docx.
  return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
}

// Response's BodyInit wants an ArrayBufferView<ArrayBuffer>; Buffer's
// underlying ArrayBufferLike may be typed as a SharedArrayBuffer, so tests
// copy into a fresh Uint8Array before constructing a mock Response — same
// reasoning as toArrayBufferView in client.ts.
function toResponseBody(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(new ArrayBuffer(buffer.length));
  view.set(buffer);
  return view;
}

function timeoutError(): Error {
  return Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
}

const validParseJob = {
  jobId: '11111111-1111-4111-8111-111111111111',
  status: 'complete',
  progress: { stage: 'complete', pct: 100 },
  result: {
    specId: '22222222-2222-4222-8222-222222222222',
    section: '09 91 26',
    title: 'Painting',
    nodeCount: 12,
  },
  expiresAt: 1_700_000_000_000,
};

const validTemplateImportData = {
  template: {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'abc123def456-run-1',
    owner: null,
    libraryId: null,
    createdAt: '2026-07-14T00:00:00.000Z',
    rules: [],
  },
  report: { nodeTypes: [], skippedNodeTypes: [], vanishSkipped: 0 },
};

describe('templateNameForRun (spike-corrected: contentHash + runId)', () => {
  const buffer = Buffer.from('reference docx bytes');

  it('is deterministic for the same buffer and runId', () => {
    expect(templateNameForRun(buffer, 'run-1')).toBe(templateNameForRun(buffer, 'run-1'));
  });

  it('differs per runId even for the same file, so repeated runs never collide', () => {
    const first = templateNameForRun(buffer, 'run-1');
    const second = templateNameForRun(buffer, 'run-2');

    expect(first).not.toBe(second);
    expect(first.endsWith('-run-1')).toBe(true);
    expect(second.endsWith('-run-2')).toBe(true);
  });

  it('prefixes with a 12-hex-char content hash', () => {
    const name = templateNameForRun(buffer, 'run-1');
    const [hashPart] = name.split('-run-1');
    expect(hashPart).toMatch(/^[0-9a-f]{12}$/);
  });

  it('differs per file content for the same runId', () => {
    const a = templateNameForRun(Buffer.from('file a'), 'run-1');
    const b = templateNameForRun(Buffer.from('file b'), 'run-1');
    expect(a).not.toBe(b);
  });

  it('rejects an empty runId as invalid external input', () => {
    expect(() => templateNameForRun(buffer, '')).toThrow(VerifyValidationError);
    expect(() => templateNameForRun(buffer, '   ')).toThrow(VerifyValidationError);
  });
});

describe('multipart DOCX uploads set an explicit Content-Type', () => {
  it('uploadForParse builds the file part as a Blob typed DOCX_MIME', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      expect(file.type).toBe(DOCX_MIME);
      return Promise.resolve(
        jsonResponse(202, { success: true, data: { jobId: validParseJob.jobId } })
      );
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await client.uploadForParse(docxBuffer(), 'reference.docx');

    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('importTemplate builds the file part as a Blob typed DOCX_MIME', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      expect(file.type).toBe(DOCX_MIME);
      return Promise.resolve(jsonResponse(201, { success: true, data: validTemplateImportData }));
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await client.importTemplate(docxBuffer(), 'reference.docx', 'run-1');

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('every HTTP response is validated before being handed back', () => {
  it('getParseJob returns the parsed ParseJob on a well-formed 200', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: validParseJob }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const job = await client.getParseJob(validParseJob.jobId);

    expect(job).toEqual(validParseJob);
  });

  it('throws VerifyApiError on a 200 whose body does not match the expected shape', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: { oops: true } }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getParseJob('any-id')).rejects.toThrow(VerifyApiError);
    await expect(client.getParseJob('any-id')).rejects.toMatchObject({ stage: 'parse' });
  });

  it('throws VerifyApiError when the response body is not JSON at all', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response('not json', { status: 200, headers: { 'content-type': 'text/plain' } })
      )
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getParseJob('any-id')).rejects.toThrow(VerifyApiError);
  });

  it('maps a non-ok HTTP status to VerifyApiError carrying the API error message', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(404, { success: false, error: 'template not found' }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.importTemplate(docxBuffer(), 'reference.docx', 'run-1')).rejects.toThrow(
      /404.*template not found/
    );
  });

  it('falls back to statusText when a non-ok response has no JSON body', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 500, statusText: 'Internal Server Error' }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.getParseJob('any-id')).rejects.toThrow(/Internal Server Error/);
  });

  it('maps a fetch timeout (AbortSignal.timeout -> TimeoutError) to VerifyApiError', async () => {
    const fetchImpl = vi.fn(() => {
      throw timeoutError();
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl, timeoutMs: 5 });

    await expect(client.getParseJob('any-id')).rejects.toThrow(VerifyApiError);
    await expect(client.getParseJob('any-id')).rejects.toThrow(/timed out after 5ms/);
  });

  it('maps any other network failure to VerifyApiError, stage matching the operation', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('ECONNREFUSED');
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.uploadForParse(docxBuffer(), 'reference.docx')).rejects.toMatchObject({
      stage: 'upload',
    });
  });
});

describe('waitForParseJob polls until a terminal state', () => {
  const runningJob = {
    jobId: validParseJob.jobId,
    status: 'running',
    progress: { stage: 'running', pct: 50 },
    expiresAt: 1_700_000_000_000,
  };
  const failedJob = {
    jobId: validParseJob.jobId,
    status: 'failed',
    progress: { stage: 'failed', pct: 0 },
    error: 'parse blew up',
    expiresAt: 1_700_000_000_000,
  };

  it('polls through running states and returns the result once the job completes', async () => {
    const sequence = [runningJob, runningJob, validParseJob];
    let call = 0;
    const fetchImpl = vi.fn(() => {
      const job = sequence[call] ?? validParseJob;
      call += 1;
      return Promise.resolve(jsonResponse(200, { success: true, data: job }));
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const result = await client.waitForParseJob(validParseJob.jobId, {
      pollIntervalMs: 1,
      timeoutMs: 1000,
    });

    expect(result).toEqual(validParseJob.result);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws VerifyApiError carrying the API error when the job fails', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: failedJob }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(
      client.waitForParseJob(validParseJob.jobId, { pollIntervalMs: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/failed: parse blew up/);
  });

  it('throws VerifyApiError when the job never completes before the deadline', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { success: true, data: runningJob }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(
      client.waitForParseJob(validParseJob.jobId, { pollIntervalMs: 1, timeoutMs: 5 })
    ).rejects.toThrow(/did not complete within/);
  });
});

describe('generateDocx validates the binary response before returning it', () => {
  it('returns the docx buffer when Content-Type and zip magic both check out', async () => {
    const bytes = docxBuffer();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(toResponseBody(bytes), { status: 200, headers: { 'content-type': DOCX_MIME } })
      )
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    const buffer = await client.generateDocx('44444444-4444-4444-4444-444444444444');

    expect(buffer.equals(bytes)).toBe(true);
  });

  it('throws VerifyApiError when Content-Type is missing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(toResponseBody(docxBuffer()), { status: 200 }))
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.generateDocx('spec-id')).rejects.toThrow(/content-type/);
  });

  it('throws VerifyApiError when Content-Type does not match DOCX_MIME', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(toResponseBody(docxBuffer()), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      )
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.generateDocx('spec-id')).rejects.toMatchObject({ stage: 'generate' });
  });

  it('throws VerifyApiError when the body is not actually a zip, despite a correct Content-Type', async () => {
    const notAZip = Buffer.from('this is not a docx');
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(toResponseBody(notAZip), {
          status: 200,
          headers: { 'content-type': DOCX_MIME },
        })
      )
    );
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.generateDocx('spec-id')).rejects.toThrow(/not a valid docx/);
  });
});

// The six header/footer fixture-provisioning methods (#305 task 2/7) are
// unit-tested against their real request/response contract in
// library-client.test.ts and project-client.test.ts — these two checks only
// pin that createApiClient() actually wires them onto the returned client,
// delegating to the same shared RequestContext as every other method.
describe('createApiClient wires the header/footer fixture-provisioning methods (#305 task 2/7)', () => {
  it('exposes all six methods on the returned client', () => {
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl: vi.fn() });

    expect(typeof client.createClientLibrary).toBe('function');
    expect(typeof client.importLibraryMaster).toBe('function');
    expect(typeof client.waitForLibraryImportJob).toBe('function');
    expect(typeof client.createProject).toBe('function');
    expect(typeof client.addSectionToProject).toBe('function');
    expect(typeof client.putProjectHeaderFooter).toBe('function');
  });

  it('createClientLibrary delegates to POST /libraries/clients against the configured baseUrl', async () => {
    const libraryId = '77777777-7777-4777-8777-777777777777';
    const fetchImpl = vi.fn((url: RequestInfo | URL) => {
      expect(url).toBe(`${BASE_URL}/libraries/clients`);
      return Promise.resolve(
        jsonResponse(201, { success: true, data: { id: libraryId, name: 'Acme' } })
      );
    });
    const client = createApiClient({ baseUrl: BASE_URL, fetchImpl });

    await expect(client.createClientLibrary('Acme')).resolves.toEqual({ id: libraryId });
  });
});
