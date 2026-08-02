// Pipeline orchestration + boundary-safety tests (#150, task 4/8):
// (1) startRun returns synchronously and drives executeRun in the
//     background, mirroring src/api/parse.ts's fire-and-forget pattern.
// (2) No raw Error or unhandled rejection ever escapes this module's async
//     boundary, even when a stage fails or when recording that failure
//     itself throws.
// (3) runGenerate's templateId param is `string | undefined` (#305 task
//     3/7) — exported alongside failRun so the sibling header/footer
//     fixture pipeline can drive its own generate stage. The invariant that
//     matters at this module's boundary: when templateId is undefined, the
//     request body handed to apiClient.generateDocx never carries a
//     `templateId` key at all (not a `templateId: undefined` key).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline, runGenerate } from './pipeline.js';
import { createRunStore, type RunStore } from './run-store.js';
import type { ApiClient, GenerateDocxOptions } from '../api-client/client.js';

// Controllable interception point for the generate stage's writeFile call
// (#604) — see the "waitForIdle does not settle" test below. `vi.hoisted`
// keeps this state reachable from the mock factory, which vitest hoists
// above this file's top-level `let`/`const` declarations. Every other
// writeFile call (e.g. reference.docx) always falls through to the real
// implementation, so the rest of this suite's real-disk assertions are
// unaffected.
const writeFileControl = vi.hoisted(() => ({
  interceptGeneratedWrite: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: (filePath: string, data: Uint8Array): Promise<void> => {
      const intercept = writeFileControl.interceptGeneratedWrite;
      if (intercept !== undefined && filePath.endsWith('generated.docx')) {
        return intercept();
      }
      return actual.writeFile(filePath, data);
    },
  };
});

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

  afterEach(async () => {
    // #604: drain any run still writing into workRoot before removing it —
    // rmSync races a detached executeRun() otherwise (ENOTEMPTY).
    await runStore.waitForIdle();
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

  it('tracks a detached run started through a spread-wrapped RunStore, so waitForIdle drains it (#604)', async () => {
    let uploadResolved = false;
    const apiClient = stubApiClient({
      uploadForParse: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            uploadResolved = true;
            resolve('job-1');
          }, 20);
        }),
    });
    // A plain spread — like brokenRunStore's own `{ ...base, ... }` shape —
    // must still forward to trackPending/waitForIdle's closure-bound
    // functions over the *base* store's `pending` Set, not lose them.
    const wrappedStore: RunStore = { ...runStore };
    const pipeline = createPipeline({ apiClient, runStore: wrappedStore });

    pipeline.startRun({
      referenceBuffer: Buffer.from('docx bytes'),
      referenceFilename: 'reference.docx',
    });

    // If startRun still discarded executeRun's completion via a bare
    // `void`, nothing would be registered in the base store's pending set,
    // and this would resolve immediately — well before the delayed
    // uploadForParse settles.
    await runStore.waitForIdle();

    expect(uploadResolved).toBe(true);
  });

  it('run-store: waitForIdle drains an in-flight run before its workRoot can be safely removed', async () => {
    const apiClient = stubApiClient();
    const pipeline = createPipeline({ apiClient, runStore });

    // Deliberately not awaited — mirrors startRun's real fire-and-forget
    // callers (e.g. src/api/parse.ts). waitForIdle is the only thing this
    // test relies on to know the run finished.
    const runId = pipeline.startRun({
      referenceBuffer: Buffer.from('docx bytes'),
      referenceFilename: 'reference.docx',
    });

    await runStore.waitForIdle();

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after waitForIdle resolved');
    expect(run.status).not.toBe('running');

    // The in-memory status check above pins nothing about the run's actual
    // disk writes (#604 finding): if runGenerate's final writeFile were ever
    // changed to fire-and-forget (`void writeFile(...)`) ahead of the
    // 'complete' updateRun() call, executeRun's tracked promise — and thus
    // waitForIdle() — would settle before generated.docx actually landed on
    // disk, while `run.status` would already read 'complete'. Assert the
    // real artifact is there, and that the run's directory is immediately,
    // deterministically removable right after waitForIdle resolves — the
    // exact precondition this test's name claims to pin.
    const generatedPath = run.artifacts.generatedPath;
    if (generatedPath === undefined) throw new Error('generatedPath missing after waitForIdle');
    expect(existsSync(generatedPath)).toBe(true);
    expect(() => rmSync(runStore.runDir(runId), { recursive: true })).not.toThrow();
  });

  it("waitForIdle does not settle until the generate stage's writeFile has actually settled (#604)", async () => {
    // A real-disk race (tiny buffer, tmpfs) settles too fast to reliably
    // catch a regression to `void writeFile(...)` — see the previous test's
    // comment. This test controls the writeFile promise directly so the
    // assertion is deterministic regardless of disk speed: it proves
    // waitForIdle()'s pending promise is genuinely chained through
    // generated.docx's write, not just through the synchronous code that
    // follows it.
    let releaseWrite: (() => void) | undefined;
    writeFileControl.interceptGeneratedWrite = () =>
      new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });

    try {
      const apiClient = stubApiClient();
      const pipeline = createPipeline({ apiClient, runStore });

      pipeline.startRun({
        referenceBuffer: Buffer.from('docx bytes'),
        referenceFilename: 'reference.docx',
      });

      await waitFor(() => releaseWrite !== undefined);

      let idleSettled = false;
      const idle = runStore.waitForIdle().then(() => {
        idleSettled = true;
      });

      // Give the microtask/timer queue ample room to (wrongly) settle
      // waitForIdle if the write were not actually being awaited.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(idleSettled).toBe(false);

      releaseWrite?.();
      await idle;

      expect(idleSettled).toBe(true);
    } finally {
      writeFileControl.interceptGeneratedWrite = undefined;
    }
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

  it('runGenerate never sends a templateId key when called with templateId=undefined', async () => {
    const capturedOptions: GenerateDocxOptions[] = [];
    const apiClient = stubApiClient({
      generateDocx: (_specId, options = {}) => {
        capturedOptions.push(options);
        return Promise.resolve(Buffer.from('generated docx bytes'));
      },
    });
    const record = runStore.createRun({ runId: 'templateless-run', referenceFilename: 'r.docx' });

    await runGenerate({ apiClient, runStore }, record.runId, 'spec-1', undefined, undefined);

    expect(capturedOptions).toHaveLength(1);
    const sentOptions = capturedOptions[0];
    if (sentOptions === undefined) throw new Error('generateDocx was never called');
    expect('templateId' in sentOptions).toBe(false);
  });
});
