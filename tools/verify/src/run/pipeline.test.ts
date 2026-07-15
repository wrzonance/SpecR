// Pipeline orchestration + boundary-safety tests (#150, task 4/8):
// (1) startRun returns synchronously and drives executeRun in the
//     background, mirroring src/api/parse.ts's fire-and-forget pattern.
// (2) No raw Error or unhandled rejection ever escapes this module's async
//     boundary, even when a stage fails or when recording that failure
//     itself throws.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPipeline } from './pipeline.js';
import { createRunStore, type RunStore } from './run-store.js';
import type { ApiClient } from '../api-client/client.js';

function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const defaults: ApiClient = {
    uploadForParse: () => Promise.resolve('job-1'),
    getParseJob: () => Promise.reject(new Error('getParseJob not stubbed')),
    waitForParseJob: () =>
      Promise.resolve({ specId: 'spec-1', section: '09 91 26', title: 'Painting', nodeCount: 1 }),
    importTemplate: () =>
      Promise.resolve({
        template: {
          id: 'template-1',
          name: 'name',
          owner: null,
          libraryId: null,
          createdAt: '2026-07-14T00:00:00.000Z',
          rules: [],
        },
        report: { nodeTypes: [], skippedNodeTypes: [], vanishSkipped: 0 },
      }),
    generateDocx: () => Promise.resolve(Buffer.from('generated docx bytes')),
    // Header/footer fixture-provisioning methods (#305 task 2/7) — not
    // exercised by this suite's own tests (that's header-footer-pipeline
    // .test.ts, task 8/7's job); stubbed only so this hand-built ApiClient
    // mock keeps satisfying the interface as it grows.
    createClientLibrary: () => Promise.reject(new Error('createClientLibrary not stubbed')),
    importLibraryMaster: () => Promise.reject(new Error('importLibraryMaster not stubbed')),
    waitForLibraryImportJob: () => Promise.reject(new Error('waitForLibraryImportJob not stubbed')),
    createProject: () => Promise.reject(new Error('createProject not stubbed')),
    addSectionToProject: () => Promise.reject(new Error('addSectionToProject not stubbed')),
    putProjectHeaderFooter: () => Promise.reject(new Error('putProjectHeaderFooter not stubbed')),
  };
  return { ...defaults, ...overrides };
}

// Broken store: createRun works, but every updateRun throws — simulates the
// failure-recording step itself failing (e.g. a disk error), proving
// failRun's last-resort catch actually prevents an unhandled rejection
// rather than being unreachable dead code.
function brokenRunStore(base: RunStore): RunStore {
  return {
    ...base,
    updateRun: () => {
      throw new Error('disk is full');
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('pipeline (orchestration + no-escape boundary)', () => {
  let workRoot: string;
  let runStore: RunStore;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-pipeline-'));
    runStore = createRunStore(workRoot);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('startRun creates the RunRecord and returns its runId synchronously', () => {
    const pipeline = createPipeline({ apiClient: stubApiClient(), runStore });

    const runId = pipeline.startRun({
      referenceBuffer: Buffer.from('docx bytes'),
      referenceFilename: 'reference.docx',
    });

    expect(typeof runId).toBe('string');
    const record = runStore.getRun(runId);
    expect(record).toBeDefined();
    expect(record?.referenceFilename).toBe('reference.docx');
  });

  it('drives a successful run through upload -> parse -> import -> generate, then stops', async () => {
    const apiClient = stubApiClient();
    const pipeline = createPipeline({ apiClient, runStore });

    const runId = pipeline.startRun({
      referenceBuffer: Buffer.from('docx bytes'),
      referenceFilename: 'reference.docx',
    });

    await waitFor(() => {
      const run = runStore.getRun(runId);
      return run?.stage === 'generate' && run.status !== 'running';
    });

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after pipeline completed');

    expect(run.status).toBe('complete');
    expect(run.artifacts.jobId).toBe('job-1');
    expect(run.artifacts.specId).toBe('spec-1');
    expect(run.artifacts.templateId).toBe('template-1');
    expect(existsSync(run.artifacts.referencePath)).toBe(true);

    const generatedPath = run.artifacts.generatedPath;
    if (generatedPath === undefined) throw new Error('generatedPath missing');
    expect(generatedPath).toBe(path.join(workRoot, runId, 'generated.docx'));
    expect(readFileSync(generatedPath, 'utf8')).toBe('generated docx bytes');
  });

  it('converts a stage failure into a RunError on the RunRecord, never throwing out of startRun', async () => {
    const apiClient = stubApiClient({
      uploadForParse: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const pipeline = createPipeline({ apiClient, runStore });

    const runId = pipeline.startRun({
      referenceBuffer: Buffer.from('docx bytes'),
      referenceFilename: 'reference.docx',
    });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error).toEqual({ stage: 'upload', message: 'ECONNREFUSED' });
  });

  it('never lets a stage failure escape as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const apiClient = stubApiClient({
        waitForParseJob: () => Promise.reject(new Error('parse job vanished')),
      });
      const pipeline = createPipeline({ apiClient, runStore });

      const runId = pipeline.startRun({
        referenceBuffer: Buffer.from('docx bytes'),
        referenceFilename: 'reference.docx',
      });

      await waitFor(() => runStore.getRun(runId)?.status === 'failed');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      expect(runStore.getRun(runId)?.error).toEqual({
        stage: 'parse',
        message: 'parse job vanished',
      });
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });

  it('never lets a failure escape even when recording the failure itself throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const apiClient = stubApiClient();
      const brokenStore = brokenRunStore(runStore);
      const pipeline = createPipeline({ apiClient, runStore: brokenStore });

      pipeline.startRun({
        referenceBuffer: Buffer.from('docx bytes'),
        referenceFilename: 'reference.docx',
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });
});
