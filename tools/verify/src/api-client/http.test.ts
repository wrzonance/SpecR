// Boundary tests for the shared HTTP internals hoisted out of client.ts
// (#305 task 1/7, decision 3): doFetch/assertOk/parseJson/buildDocxForm/
// DOCX_MIME move here verbatim so client.ts plus its future
// library-client.ts/project-client.ts siblings can all share one transport
// layer without client.ts alone crossing the repo's 400-line file cap.
// client.test.ts continues to pin the *public* ApiClient surface end to end
// (pure refactor, zero behavior change) — these tests pin the internals
// directly, at their new module boundary.
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { VerifyApiError } from '../errors.js';
import { assertOk, buildDocxForm, doFetch, DOCX_MIME, parseJson } from './http.js';
import type { RequestContext } from './http.js';

const BASE_URL = 'http://localhost:3000';

function ctxWith(fetchImpl: typeof fetch, timeoutMs = 30_000): RequestContext {
  return { baseUrl: BASE_URL, fetchImpl, timeoutMs };
}

describe('DOCX_MIME', () => {
  it('is the OOXML wordprocessingml content type', () => {
    expect(DOCX_MIME).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });
});

describe('buildDocxForm', () => {
  it('sets the file part Content-Type to DOCX_MIME', () => {
    const form = buildDocxForm(Buffer.from('bytes'), 'reference.docx');
    const file = form.get('file') as File;
    expect(file.type).toBe(DOCX_MIME);
    expect(file.name).toBe('reference.docx');
  });
});

describe('doFetch', () => {
  it('returns the Response on success', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('ok')));
    const response = await doFetch(ctxWith(fetchImpl), '/parse', { method: 'GET' }, 'upload');
    expect(response.status).toBe(200);
  });

  it('maps a TimeoutError to VerifyApiError carrying the stage', async () => {
    const fetchImpl = vi.fn(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(
      doFetch(ctxWith(fetchImpl, 5), '/parse', { method: 'GET' }, 'upload')
    ).rejects.toMatchObject({ stage: 'upload' });
  });

  it('maps any other network failure to VerifyApiError', async () => {
    const fetchImpl = vi.fn(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      doFetch(ctxWith(fetchImpl), '/parse', { method: 'GET' }, 'import')
    ).rejects.toThrow(VerifyApiError);
  });
});

describe('assertOk', () => {
  it('resolves without throwing on an ok response', async () => {
    await expect(assertOk(new Response('ok'), '/parse', 'upload')).resolves.toBeUndefined();
  });

  it('throws VerifyApiError carrying the API error message on a non-ok JSON body', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'not found' }), {
      status: 404,
    });
    await expect(assertOk(response, '/parse', 'upload')).rejects.toThrow(/404.*not found/);
  });

  it('falls back to statusText when the non-ok response has no JSON body', async () => {
    const response = new Response(null, { status: 500, statusText: 'Internal Server Error' });
    await expect(assertOk(response, '/parse', 'upload')).rejects.toThrow(/Internal Server Error/);
  });
});

describe('parseJson', () => {
  const schema = z.object({ ok: z.boolean() });

  it('returns the parsed value when the body matches the schema', async () => {
    const response = new Response(JSON.stringify({ ok: true }));
    await expect(parseJson(response, schema, '/parse', 'upload')).resolves.toEqual({ ok: true });
  });

  it('throws VerifyApiError when the body is not valid JSON', async () => {
    const response = new Response('not json');
    await expect(parseJson(response, schema, '/parse', 'upload')).rejects.toThrow(VerifyApiError);
  });

  it('throws VerifyApiError when the body does not match the schema', async () => {
    const response = new Response(JSON.stringify({ oops: true }));
    await expect(parseJson(response, schema, '/parse', 'upload')).rejects.toMatchObject({
      stage: 'upload',
    });
  });
});
