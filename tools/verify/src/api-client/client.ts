// API client layer for the visual round-trip verification harness (#150):
// drives the real SpecR REST API end to end — parse -> poll -> import
// template -> generate. Never an in-process shortcut (design decision 3):
// every call is a real HTTP request against SPECR_API_BASE_URL, and every
// response this client hands back to its caller has already been either
// Zod-parsed or content-type/zip-magic checked. A shape the client cannot
// validate never reaches the caller as if it were trustworthy data.

import { createHash } from 'node:crypto';
import { VerifyApiError, VerifyValidationError, type RunStage } from '../errors.js';
import {
  ErrorResponseSchema,
  ParseJobResponseSchema,
  ParseJobResultSchema,
  ParseJobSchema,
  ParseUploadResponseSchema,
  TemplateImportDataSchema,
  TemplateImportResponseSchema,
  type ParseJob,
  type ParseJobResult,
  type SectionNumberFormat,
  type TemplateImportData,
} from './schemas.js';
import type { z } from 'zod';

// Every multipart DOCX upload MUST set this explicitly on its Blob — a
// type-less Blob part omits Content-Type on the multipart part, and
// src/api/parse.ts's uploadMimeError() 400s a request that arrives that way
// (spike finding 3a). This is load-bearing, not incidental.
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// DOCX is a zip container; every zip begins with this local-file-header
// signature. Backstops the Content-Type check on POST /specs/{id}/generate's
// binary response — see cropRegion's bounds-check for the harness's other
// "confirmed load-bearing, not defensive paranoia" backstop (design decision 3).
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

export interface ApiClientConfig {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface UploadForParseOptions {
  readonly section?: string;
  readonly title?: string;
  readonly numberingProfileId?: string;
}

export interface WaitForParseJobOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export interface ImportTemplateOptions {
  readonly owner?: string;
}

export interface GenerateDocxOptions {
  readonly templateId?: string;
  readonly sectionNumberFormat?: SectionNumberFormat;
}

export interface ApiClient {
  uploadForParse(
    buffer: Buffer,
    filename: string,
    options?: UploadForParseOptions
  ): Promise<string>;
  getParseJob(jobId: string): Promise<ParseJob>;
  waitForParseJob(jobId: string, options?: WaitForParseJobOptions): Promise<ParseJobResult>;
  importTemplate(
    buffer: Buffer,
    filename: string,
    runId: string,
    options?: ImportTemplateOptions
  ): Promise<TemplateImportData>;
  generateDocx(specId: string, options?: GenerateDocxOptions): Promise<Buffer>;
}

interface RequestContext {
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

function buildDocxForm(buffer: Buffer, filename: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([toArrayBufferView(buffer)], { type: DOCX_MIME }), filename);
  return form;
}

async function doFetch(
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

async function assertOk(response: Response, path: string, stage: RunStage): Promise<void> {
  if (response.ok) return;
  const message = await extractErrorMessage(response);
  throw new VerifyApiError(`${path} returned ${String(response.status)}: ${message}`, { stage });
}

// Every JSON response this client hands to a caller passes through here —
// the single point where "unexpected shape" (VerifyApiError's own stated
// domain, per errors.ts) is enforced for the SpecR REST API's responses.
async function parseJson<Schema extends z.ZodTypeAny>(
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

// sha256(fileBytes) sliced to 12 hex chars + runId, so repeated harness runs
// against the same reference file never collide on template name and never
// 409 on a stale name from a prior run (spike finding 3b, invariant pinned
// in client.test.ts). `runId` is caller-supplied external input — validated
// here, not assumed non-empty.
export function templateNameForRun(buffer: Buffer, runId: string): string {
  if (runId.trim() === '') {
    throw new VerifyValidationError('runId must be a non-empty string', { stage: 'import' });
  }
  const contentHash = createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  return `${contentHash}-${runId}`;
}

async function uploadForParse(
  ctx: RequestContext,
  buffer: Buffer,
  filename: string,
  options: UploadForParseOptions = {}
): Promise<string> {
  const form = buildDocxForm(buffer, filename);
  if (options.section !== undefined) form.append('section', options.section);
  if (options.title !== undefined) form.append('title', options.title);
  if (options.numberingProfileId !== undefined) {
    form.append('numberingProfileId', options.numberingProfileId);
  }

  const response = await doFetch(ctx, '/parse', { method: 'POST', body: form }, 'upload');
  await assertOk(response, '/parse', 'upload');
  const body = await parseJson(response, ParseUploadResponseSchema, '/parse', 'upload');
  return body.data.jobId;
}

async function getParseJob(ctx: RequestContext, jobId: string): Promise<ParseJob> {
  const path = `/parse/jobs/${jobId}`;
  const response = await doFetch(ctx, path, { method: 'GET' }, 'parse');
  await assertOk(response, path, 'parse');
  const body = await parseJson(response, ParseJobResponseSchema, path, 'parse');
  return ParseJobSchema.parse(body.data);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForParseJob(
  ctx: RequestContext,
  jobId: string,
  options: WaitForParseJobOptions = {}
): Promise<ParseJobResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const job = await getParseJob(ctx, jobId);
    if (job.status === 'complete') {
      const result = ParseJobResultSchema.safeParse(job.result);
      if (!result.success) {
        throw new VerifyApiError(`parse job ${jobId} completed with no result`, { stage: 'parse' });
      }
      return result.data;
    }
    if (job.status === 'failed') {
      throw new VerifyApiError(`parse job ${jobId} failed: ${job.error ?? 'unknown error'}`, {
        stage: 'parse',
      });
    }
    if (Date.now() > deadline) {
      throw new VerifyApiError(
        `parse job ${jobId} did not complete within ${String(timeoutMs)}ms`,
        {
          stage: 'parse',
        }
      );
    }
    await sleep(pollIntervalMs);
  }
}

async function importTemplate(
  ctx: RequestContext,
  buffer: Buffer,
  filename: string,
  runId: string,
  options: ImportTemplateOptions = {}
): Promise<TemplateImportData> {
  const name = templateNameForRun(buffer, runId);
  const form = buildDocxForm(buffer, filename);
  form.append('name', name);
  if (options.owner !== undefined) form.append('owner', options.owner);

  const response = await doFetch(
    ctx,
    '/templates/import',
    { method: 'POST', body: form },
    'import'
  );
  await assertOk(response, '/templates/import', 'import');
  const body = await parseJson(
    response,
    TemplateImportResponseSchema,
    '/templates/import',
    'import'
  );
  return TemplateImportDataSchema.parse(body.data);
}

async function readDocxBody(response: Response, path: string): Promise<Buffer> {
  const contentType = response.headers.get('content-type');
  if (contentType === null || !contentType.startsWith(DOCX_MIME)) {
    throw new VerifyApiError(
      `${path} response had unexpected content-type: ${contentType ?? '(missing)'}`,
      { stage: 'generate' }
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw new VerifyApiError(`${path} response body is not a valid docx (zip) file`, {
      stage: 'generate',
    });
  }
  return buffer;
}

function generateRequestBody(options: GenerateDocxOptions): string {
  const payload: Record<string, string> = {};
  if (options.templateId !== undefined) payload['templateId'] = options.templateId;
  if (options.sectionNumberFormat !== undefined) {
    payload['sectionNumberFormat'] = options.sectionNumberFormat;
  }
  return JSON.stringify(payload);
}

async function generateDocx(
  ctx: RequestContext,
  specId: string,
  options: GenerateDocxOptions = {}
): Promise<Buffer> {
  const path = `/specs/${specId}/generate`;
  const response = await doFetch(
    ctx,
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: generateRequestBody(options),
    },
    'generate'
  );
  await assertOk(response, path, 'generate');
  return readDocxBody(response, path);
}

export function createApiClient(cfg: ApiClientConfig): ApiClient {
  const ctx: RequestContext = {
    baseUrl: cfg.baseUrl,
    fetchImpl: cfg.fetchImpl ?? fetch,
    timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return {
    uploadForParse: (buffer, filename, options) => uploadForParse(ctx, buffer, filename, options),
    getParseJob: (jobId) => getParseJob(ctx, jobId),
    waitForParseJob: (jobId, options) => waitForParseJob(ctx, jobId, options),
    importTemplate: (buffer, filename, runId, options) =>
      importTemplate(ctx, buffer, filename, runId, options),
    generateDocx: (specId, options) => generateDocx(ctx, specId, options),
  };
}
