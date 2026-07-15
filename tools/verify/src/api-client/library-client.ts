// Library-onboarding API-client methods for the visual round-trip
// verification harness's header/footer fixture pipeline (#305 task 2/7):
// POST /libraries/clients, POST /libraries/{id}/import,
// GET /libraries/import/jobs/{jobId}. Same validation discipline as
// client.ts's original methods (see http.ts's docstring) — every response
// this module hands back has already been Zod-parsed.
//
// waitForLibraryImportJob has its OWN poll loop, deliberately not sharing
// client.ts's waitForParseJob: library-onboarding jobs report
// OnboardingStageSchema's terminal vocabulary (queued/running/parsing/
// persisting/deriving-style/classifying/complete/failed) — a different
// enum than ParseStageSchema's finer-grained parse sub-stages (spike
// finding 5 / struct #5's correction).

import { VerifyApiError } from '../errors.js';
import { assertOk, buildDocxForm, doFetch, parseJson } from './http.js';
import type { RequestContext } from './http.js';
import {
  CreateClientLibraryResponseSchema,
  ImportLibraryMasterResponseSchema,
  OnboardingJobResponseSchema,
  type OnboardingJob,
  type OnboardingJobResult,
} from './schemas.js';

export interface WaitForLibraryImportJobOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createClientLibrary(
  ctx: RequestContext,
  name: string
): Promise<{ id: string }> {
  const response = await doFetch(
    ctx,
    '/libraries/clients',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    'upload'
  );
  await assertOk(response, '/libraries/clients', 'upload');
  const body = await parseJson(
    response,
    CreateClientLibraryResponseSchema,
    '/libraries/clients',
    'upload'
  );
  return { id: body.data.id };
}

export async function importLibraryMaster(
  ctx: RequestContext,
  libraryId: string,
  buffer: Buffer,
  filename: string
): Promise<string> {
  const path = `/libraries/${libraryId}/import`;
  const form = buildDocxForm(buffer, filename);
  const response = await doFetch(ctx, path, { method: 'POST', body: form }, 'upload');
  await assertOk(response, path, 'upload');
  const body = await parseJson(response, ImportLibraryMasterResponseSchema, path, 'upload');
  return body.data.jobId;
}

async function getLibraryImportJob(ctx: RequestContext, jobId: string): Promise<OnboardingJob> {
  const path = `/libraries/import/jobs/${jobId}`;
  const response = await doFetch(ctx, path, { method: 'GET' }, 'upload');
  await assertOk(response, path, 'upload');
  const body = await parseJson(response, OnboardingJobResponseSchema, path, 'upload');
  return body.data;
}

export async function waitForLibraryImportJob(
  ctx: RequestContext,
  jobId: string,
  options: WaitForLibraryImportJobOptions = {}
): Promise<OnboardingJobResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const job = await getLibraryImportJob(ctx, jobId);
    if (job.status === 'complete') {
      if (job.result === undefined) {
        throw new VerifyApiError(`library import job ${jobId} completed with no result`, {
          stage: 'upload',
        });
      }
      return job.result;
    }
    if (job.status === 'failed') {
      throw new VerifyApiError(
        `library import job ${jobId} failed: ${job.error ?? 'unknown error'}`,
        { stage: 'upload' }
      );
    }
    if (Date.now() > deadline) {
      throw new VerifyApiError(
        `library import job ${jobId} did not complete within ${String(timeoutMs)}ms`,
        { stage: 'upload' }
      );
    }
    await sleep(pollIntervalMs);
  }
}
