// API client layer for the visual round-trip verification harness (#150):
// drives the real SpecR REST API end to end — parse -> poll -> import
// template -> generate. Never an in-process shortcut (design decision 3):
// every call is a real HTTP request against SPECR_API_BASE_URL, and every
// response this client hands back to its caller has already been either
// Zod-parsed or content-type/zip-magic checked. A shape the client cannot
// validate never reaches the caller as if it were trustworthy data.

import { createHash } from 'node:crypto';
import { VerifyApiError, VerifyValidationError } from '../errors.js';
import { assertOk, buildDocxForm, doFetch, DOCX_MIME, parseJson } from './http.js';
import type { RequestContext } from './http.js';
import {
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
  type AddSectionToProjectResult,
  type HeaderFooterConfig,
  type OnboardingJobResult,
} from './schemas.js';
import {
  createClientLibrary,
  importLibraryMaster,
  waitForLibraryImportJob,
  type WaitForLibraryImportJobOptions,
} from './library-client.js';
import {
  addSectionToProject,
  createProject,
  putProjectHeaderFooter,
  type HeaderFooterCompositionInput,
} from './project-client.js';

export { DOCX_MIME };
export type {
  HeaderFooterCompositionInput,
  HeaderFooterFieldInput,
  HeaderFooterVariantInput,
} from './project-client.js';
export type { WaitForLibraryImportJobOptions } from './library-client.js';

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
  // Header/footer fixture provisioning (#305 task 2/7) — library-client.ts
  // and project-client.ts drive these six against the real REST API; see
  // those modules for the per-method request/response contract.
  createClientLibrary(name: string): Promise<{ id: string }>;
  importLibraryMaster(libraryId: string, buffer: Buffer, filename: string): Promise<string>;
  waitForLibraryImportJob(
    jobId: string,
    options?: WaitForLibraryImportJobOptions
  ): Promise<OnboardingJobResult>;
  createProject(name: string, sourceLibraryIds: readonly string[]): Promise<{ projectId: string }>;
  addSectionToProject(projectId: string, section: string): Promise<AddSectionToProjectResult>;
  putProjectHeaderFooter(
    projectId: string,
    composition: HeaderFooterCompositionInput
  ): Promise<HeaderFooterConfig>;
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
    createClientLibrary: (name) => createClientLibrary(ctx, name),
    importLibraryMaster: (libraryId, buffer, filename) =>
      importLibraryMaster(ctx, libraryId, buffer, filename),
    waitForLibraryImportJob: (jobId, options) => waitForLibraryImportJob(ctx, jobId, options),
    createProject: (name, sourceLibraryIds) => createProject(ctx, name, sourceLibraryIds),
    addSectionToProject: (projectId, section) => addSectionToProject(ctx, projectId, section),
    putProjectHeaderFooter: (projectId, composition) =>
      putProjectHeaderFooter(ctx, projectId, composition),
  };
}
