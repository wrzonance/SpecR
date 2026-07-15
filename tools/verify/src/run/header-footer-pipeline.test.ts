// Header/footer fixture pipeline orchestration tests (#305, task 6/7):
// (1) startRun never throws synchronously for a scenarioId drawn from the
//     closed HEADER_FOOTER_SCENARIOS catalog — mirrors pipeline.test.ts's
//     own "startRun creates the RunRecord ... synchronously" invariant, but
//     exercised across every catalog entry since this pipeline's own
//     scenario lookup (findScenario) is a new synchronous failure point
//     pipeline.ts's startRun never had.
// (2) A full run drives library -> project -> header/footer-config ->
//     generate, recording each stage's artifact on the RunRecord.
// (3) No raw Error or unhandled rejection ever escapes this module's async
//     boundary, same no-escape contract as pipeline.ts's own executeRun.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHeaderFooterFixturePipeline } from './header-footer-pipeline.js';
import { createRunStore, type RunStore } from './run-store.js';
import { HEADER_FOOTER_SCENARIOS } from '../fixtures/header-footer-scenarios.js';
import type { ApiClient } from '../api-client/client.js';
import type {
  AddSectionToProjectResult,
  HeaderFooterConfig,
  OnboardingJobResult,
} from '../api-client/schemas.js';

function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const onboardingResult: OnboardingJobResult = {
    templateId: null,
    report: { nodeTypes: [], skippedNodeTypes: [], vanishSkipped: 0 },
  };
  const addSectionResult: AddSectionToProjectResult = {
    specId: 'project-spec-1',
    section: '07 92 00',
    position: 1,
    source: { libraryId: 'library-1', name: 'fixture library' },
  };
  const headerFooterConfig: HeaderFooterConfig = {
    id: 'hf-config-1',
    scope: { kind: 'project', projectId: 'project-1' },
    config: {},
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  };

  const defaults: ApiClient = {
    uploadForParse: () => Promise.reject(new Error('uploadForParse not stubbed')),
    getParseJob: () => Promise.reject(new Error('getParseJob not stubbed')),
    waitForParseJob: () => Promise.reject(new Error('waitForParseJob not stubbed')),
    importTemplate: () => Promise.reject(new Error('importTemplate not stubbed')),
    generateDocx: () => Promise.resolve(Buffer.from('generated docx bytes')),
    createClientLibrary: () => Promise.resolve({ id: 'library-1' }),
    importLibraryMaster: () => Promise.resolve('import-job-1'),
    waitForLibraryImportJob: () => Promise.resolve(onboardingResult),
    createProject: () => Promise.resolve({ projectId: 'project-1' }),
    addSectionToProject: () => Promise.resolve(addSectionResult),
    putProjectHeaderFooter: () => Promise.resolve(headerFooterConfig),
  };
  return { ...defaults, ...overrides };
}

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

describe('header-footer fixture pipeline (orchestration + no-escape boundary)', () => {
  let workRoot: string;
  let runStore: RunStore;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-hf-pipeline-'));
    runStore = createRunStore(workRoot);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it.each(HEADER_FOOTER_SCENARIOS.map((scenario) => scenario.id))(
    'startRun never throws synchronously for catalog scenario %s',
    (scenarioId) => {
      const pipeline = createHeaderFooterFixturePipeline({
        apiClient: stubApiClient(),
        runStore,
      });

      const runId = pipeline.startRun({ scenarioId });

      expect(typeof runId).toBe('string');
      const record = runStore.getRun(runId);
      expect(record).toBeDefined();
      expect(record?.section).toBe(
        HEADER_FOOTER_SCENARIOS.find((s) => s.id === scenarioId)?.section
      );
    }
  );

  it('drives a successful run through library -> project -> header/footer-config -> generate', async () => {
    const apiClient = stubApiClient();
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => {
      const run = runStore.getRun(runId);
      return run?.stage === 'generate' && run.status !== 'running';
    });

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after pipeline completed');

    expect(run.status).toBe('complete');
    expect(run.artifacts.libraryId).toBe('library-1');
    expect(run.artifacts.projectId).toBe('project-1');
    expect(run.artifacts.projectSpecId).toBe('project-spec-1');
    expect(run.artifacts.headerFooterConfigId).toBe('hf-config-1');
    expect(existsSync(run.artifacts.referencePath)).toBe(true);

    const generatedPath = run.artifacts.generatedPath;
    if (generatedPath === undefined) throw new Error('generatedPath missing');
    expect(generatedPath).toBe(path.join(workRoot, runId, 'generated.docx'));
    expect(readFileSync(generatedPath, 'utf8')).toBe('generated docx bytes');
  });

  it('converts a stage failure into a RunError on the RunRecord, never throwing out of startRun', async () => {
    const apiClient = stubApiClient({
      createClientLibrary: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error).toEqual({ stage: 'upload', message: 'ECONNREFUSED' });
  });

  it('records an import-stage failure when project provisioning fails', async () => {
    const apiClient = stubApiClient({
      createProject: () => Promise.reject(new Error('project quota exceeded')),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error).toEqual({ stage: 'import', message: 'project quota exceeded' });
    expect(run.artifacts.libraryId).toBe('library-1');
  });

  it('never lets a stage failure escape as an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const apiClient = stubApiClient({
        putProjectHeaderFooter: () => Promise.reject(new Error('header/footer config vanished')),
      });
      const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

      const runId = pipeline.startRun({ scenarioId: 'default' });

      await waitFor(() => runStore.getRun(runId)?.status === 'failed');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      expect(runStore.getRun(runId)?.error).toEqual({
        stage: 'import',
        message: 'header/footer config vanished',
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
      const broken = brokenRunStore(runStore);
      const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore: broken });

      pipeline.startRun({ scenarioId: 'default' });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });
});
