// Orchestrates one verification run's reference-DOCX -> API round-trip
// (#150, task 4/8): upload -> parse -> import -> generate. Mirrors
// src/api/parse.ts's fire-and-forget pattern — startRun() creates the
// RunRecord synchronously and returns its runId immediately; the actual
// work happens in executeRun(), invoked with `void` so its caller (a
// future HTTP handler) never awaits it.
//
// Per issue #150 design decision 3, this pipeline stops at 'generate'.
// Rendering, measuring, screenshotting, and diffing are separate explicit
// stages driven by later tasks, each extending the same RunRecord via
// runStore.updateRun().
//
// executeRun's single try/catch wraps every stage: whatever throws — an
// api-client VerifyApiError, a plain Error from fs, or anything else — is
// converted through toRunError() before being written to the RunRecord. No
// raw Error or unhandled rejection ever escapes this module's async
// boundary (see errors.ts).

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { toRunError, type RunStage } from '../errors.js';
import type { ApiClient, UploadForParseOptions } from '../api-client/client.js';
import type { RunStore } from './run-store.js';
import type { RunRecord, StartRunOptions } from './types.js';

export interface PipelineDeps {
  readonly apiClient: ApiClient;
  readonly runStore: RunStore;
}

export interface StartRunInput {
  readonly referenceBuffer: Buffer;
  readonly referenceFilename: string;
  readonly options?: StartRunOptions;
}

export interface Pipeline {
  /**
   * Create a RunRecord and start driving it through upload -> parse ->
   * import -> generate in the background. Returns the new run's id
   * immediately; poll its progress via PipelineDeps.runStore.getRun().
   */
  startRun(input: StartRunInput): string;
}

function uploadOptions(options: StartRunOptions | undefined): UploadForParseOptions {
  return {
    ...(options?.section !== undefined ? { section: options.section } : {}),
    ...(options?.title !== undefined ? { title: options.title } : {}),
  };
}

async function runUpload(
  deps: PipelineDeps,
  record: RunRecord,
  input: StartRunInput
): Promise<string> {
  deps.runStore.updateRun(record.runId, { stage: 'upload', status: 'running' });
  writeFileSync(record.artifacts.referencePath, input.referenceBuffer);
  const jobId = await deps.apiClient.uploadForParse(
    input.referenceBuffer,
    input.referenceFilename,
    uploadOptions(input.options)
  );
  deps.runStore.updateRun(record.runId, {
    stage: 'upload',
    status: 'complete',
    artifacts: { jobId },
  });
  return jobId;
}

async function runParse(deps: PipelineDeps, runId: string, jobId: string): Promise<string> {
  deps.runStore.updateRun(runId, { stage: 'parse', status: 'running' });
  const result = await deps.apiClient.waitForParseJob(jobId);
  deps.runStore.updateRun(runId, {
    stage: 'parse',
    status: 'complete',
    artifacts: { specId: result.specId },
  });
  return result.specId;
}

async function runImport(
  deps: PipelineDeps,
  record: RunRecord,
  input: StartRunInput
): Promise<string> {
  deps.runStore.updateRun(record.runId, { stage: 'import', status: 'running' });
  const { template, report } = await deps.apiClient.importTemplate(
    input.referenceBuffer,
    input.referenceFilename,
    record.runId
  );
  deps.runStore.updateRun(record.runId, {
    stage: 'import',
    status: 'complete',
    artifacts: { templateId: template.id, derivationReport: report },
  });
  return template.id;
}

async function runGenerate(
  deps: PipelineDeps,
  runId: string,
  specId: string,
  templateId: string,
  options: StartRunOptions | undefined
): Promise<void> {
  deps.runStore.updateRun(runId, { stage: 'generate', status: 'running' });
  const buffer = await deps.apiClient.generateDocx(specId, {
    templateId,
    ...(options?.sectionNumberFormat !== undefined
      ? { sectionNumberFormat: options.sectionNumberFormat }
      : {}),
  });
  const generatedPath = path.join(deps.runStore.runDir(runId), 'generated.docx');
  writeFileSync(generatedPath, buffer);
  deps.runStore.updateRun(runId, {
    stage: 'generate',
    status: 'complete',
    artifacts: { generatedPath },
  });
}

// Record a stage failure on the RunRecord. If even that fails (e.g. disk
// I/O is the root cause), there is nowhere further to report to — swallow
// it here rather than let it become an unhandled rejection escaping this
// fire-and-forget pipeline (see module docstring).
function failRun(deps: PipelineDeps, runId: string, stage: RunStage, err: unknown): void {
  const error = toRunError(stage, err);
  try {
    deps.runStore.updateRun(runId, { status: 'failed', stage: error.stage, error });
  } catch {
    // Last resort: recording the failure itself failed. Nothing further
    // this pipeline can safely do without risking an unhandled rejection.
  }
}

async function executeRun(
  deps: PipelineDeps,
  record: RunRecord,
  input: StartRunInput
): Promise<void> {
  let stage: RunStage = 'upload';
  try {
    const jobId = await runUpload(deps, record, input);
    stage = 'parse';
    const specId = await runParse(deps, record.runId, jobId);
    stage = 'import';
    const templateId = await runImport(deps, record, input);
    stage = 'generate';
    await runGenerate(deps, record.runId, specId, templateId, input.options);
  } catch (err) {
    failRun(deps, record.runId, stage, err);
  }
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  function startRun(input: StartRunInput): string {
    const runId = randomUUID();
    const record = deps.runStore.createRun({
      runId,
      referenceFilename: input.referenceFilename,
      ...(input.options?.section !== undefined ? { section: input.options.section } : {}),
      ...(input.options?.title !== undefined ? { title: input.options.title } : {}),
    });
    void executeRun(deps, record, input);
    return record.runId;
  }

  return { startRun };
}
