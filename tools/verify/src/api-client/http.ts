// Shared HTTP transport internals for the visual round-trip verification
// harness's API client layer (#150, #305 task 1/7 decision 3). Hoisted
// verbatim out of client.ts: doFetch/assertOk/parseJson/buildDocxForm/
// DOCX_MIME/RequestContext no longer live only in client.ts because
// client.ts's future library-client.ts/project-client.ts siblings (fixture
// provisioning for #305) need the exact same request/response validation
// discipline — every response this layer hands back has already been
// either Zod-parsed or content-type/zip-magic checked, and a shape it
// cannot validate never reaches a caller as if it were trustworthy data.
// Splitting this out (rather than appending six new methods directly into
// client.ts) is what keeps client.ts itself under the repo's 400-line file
// cap — see file-line-budget.test.ts.

import { VerifyApiError, type RunStage } from '../errors.js';
import { ErrorResponseSchema } from './schemas.js';
import type { z } from 'zod';

// Every multipart DOCX upload MUST set this explicitly on its Blob — a
// type-less Blob part omits Content-Type on the multipart part, and
// src/api/parse.ts's uploadMimeError() 400s a request that arrives that way
// (spike finding 3a). This is load-bearing, not incidental.
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface RequestContext {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}

// Blob/Response bodies want an ArrayBufferView<ArrayBuffer>; Buffer's
// underlying ArrayBufferLike may be typed as a SharedArrayBuffer, so copy
// into a fresh, definitely-non-shared Uint8Array rather than reach for a
// cross-boundary type assertion.
function toArrayBufferView(buffer: Buffer): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(new ArrayBuffer(buffer.length));
  view.set(buffer);
  return view;
}

export function buildDocxForm(buffer: Buffer, filename: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([toArrayBufferView(buffer)], { type: DOCX_MIME }), filename);
  return form;
}

export async function doFetch(
  ctx: RequestContext,
  path: string,
  init: RequestInit,
  stage: RunStage
): Promise<Response> {
  const url = new URL(path, ctx.baseUrl).toString();
  try {
    return await ctx.fetchImpl(url, { ...init, signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new VerifyApiError(`request to ${path} timed out after ${ctx.timeoutMs}ms`, {
        stage,
        cause: err,
      });
    }
    throw new VerifyApiError(`request to ${path} failed: network error`, { stage, cause: err });
  }
}

async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const parsed = ErrorResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.error : response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function assertOk(response: Response, path: string, stage: RunStage): Promise<void> {
  if (response.ok) return;
  const message = await extractErrorMessage(response);
  throw new VerifyApiError(`${path} returned ${String(response.status)}: ${message}`, { stage });
}

// Every JSON response this client hands to a caller passes through here —
// the single point where "unexpected shape" (VerifyApiError's own stated
// domain, per errors.ts) is enforced for the SpecR REST API's responses.
export async function parseJson<Schema extends z.ZodTypeAny>(
  response: Response,
  schema: Schema,
  path: string,
  stage: RunStage
): Promise<z.infer<Schema>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new VerifyApiError(`${path} response was not valid JSON`, { stage, cause: err });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new VerifyApiError(`${path} response did not match the expected shape`, {
      stage,
      cause: result.error,
    });
  }
  return result.data;
}
