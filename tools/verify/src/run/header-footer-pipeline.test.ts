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
import {
  buildScenarioReferenceDocx,
  findScenario,
  HEADER_FOOTER_SCENARIOS,
} from '../fixtures/header-footer-scenarios.js';
import type { ApiClient } from '../api-client/client.js';
import type {
  AddSectionToProjectResult,
  HeaderFooterConfig,
  OnboardingJobResult,
} from '../api-client/schemas.js';

// The 'default' scenario's own section/title (HEADER_FOOTER_SCENARIOS) —
// stubApiClient's default waitForLibraryImportJob result matches these
// exactly, so a full run through startRun({ scenarioId: 'default' }) never
// trips the pipeline's own real-parser-identity assertion. Tests that need
// a MISMATCH pass an onboardingResult override built from this via
// buildOnboardingResult.
const DEFAULT_SCENARIO_SECTION = '07 92 00';
const DEFAULT_SCENARIO_TITLE = 'Joint Sealants';

// The 'restartPerSpec' scenario's own section/title — the only catalog entry
// whose composition carries pageNumbering.mode === 'restartPerSpec', so it is
// the one that exercises the post-generate OOXML page-numbering assertion.
const RESTART_SCENARIO_SECTION = '26 05 00';
const RESTART_SCENARIO_TITLE = 'Common Work Results for Electrical';

function buildOnboardingResult(overrides: Partial<OnboardingJobResult> = {}): OnboardingJobResult {
  return {
    specId: 'spec-1',
    section: DEFAULT_SCENARIO_SECTION,
    title: DEFAULT_SCENARIO_TITLE,
    libraryId: 'library-1',
    templateId: null,
    report: {
      styleDerivation: { nodeTypes: [], skippedNodeTypes: [], vanishSkipped: 0 },
      styleSourceNeeded: true,
      headerFooter: null,
      editability: {
        counts: { locked: 0, editable: 0, choice: 0, note: 0 },
        lowConfidence: [],
      },
      hierarchy: {
        counts: { scored: 0, unscored: 0, belowThreshold: 0 },
        lowConfidence: [],
      },
      parseWarnings: [],
    },
    ...overrides,
  };
}

function stubApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const onboardingResult = buildOnboardingResult();
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

// api-client stub tuned so a 'restartPerSpec' run clears every identity gate
// (parse round-trip, provisioned section, project scope) and reaches the
// post-generate page-numbering assertion, with generateDocx returning the
// DOCX under test.
function restartPerSpecClient(generateDocx: () => Promise<Buffer>): ApiClient {
  return stubApiClient({
    waitForLibraryImportJob: () =>
      Promise.resolve(
        buildOnboardingResult({
          section: RESTART_SCENARIO_SECTION,
          title: RESTART_SCENARIO_TITLE,
        })
      ),
    addSectionToProject: () =>
      Promise.resolve({
        specId: 'project-spec-1',
        section: RESTART_SCENARIO_SECTION,
        position: 1,
        source: { libraryId: 'library-1', name: 'fixture library' },
      }),
    generateDocx,
  });
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
    async (scenarioId) => {
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

      // startRun's synchronous contract is asserted above; now let the
      // fire-and-forget run reach a terminal state before afterEach removes
      // workRoot, so a background artifact write can never race cleanup.
      await waitFor(() => {
        const status = runStore.getRun(runId)?.status;
        return status === 'complete' || status === 'failed';
      });
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

  it('fails the upload stage when the real parser resolves a different title than the scenario expects', async () => {
    const apiClient = stubApiClient({
      waitForLibraryImportJob: () =>
        Promise.resolve(buildOnboardingResult({ title: 'A Completely Different Title' })),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('upload');
    expect(run.error?.message).toContain('A Completely Different Title');
    expect(run.error?.message).toContain(DEFAULT_SCENARIO_TITLE);
    // Never reaches project provisioning once the identity check fails.
    expect(run.artifacts.projectId).toBeUndefined();
  });

  it('fails the upload stage when the real parser resolves a different section than the scenario expects', async () => {
    const apiClient = stubApiClient({
      waitForLibraryImportJob: () =>
        Promise.resolve(buildOnboardingResult({ section: '99 99 99' })),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('upload');
    expect(run.error?.message).toContain('99 99 99');
    expect(run.error?.message).toContain(DEFAULT_SCENARIO_SECTION);
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

  it('completes a restartPerSpec run whose generated DOCX declares the page-numbering restart', async () => {
    const generatedDocx = await buildScenarioReferenceDocx(findScenario('restartPerSpec'));
    const apiClient = restartPerSpecClient(() => Promise.resolve(generatedDocx));
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'restartPerSpec' });

    await waitFor(() => {
      const run = runStore.getRun(runId);
      return run?.stage === 'generate' && run.status === 'complete';
    });
    // Let the post-generate page-numbering assertion settle — on success it
    // leaves stage/status untouched, so confirm it did not flip to failed.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after pipeline completed');
    expect(run.status).toBe('complete');
    expect(run.error).toBeUndefined();
    expect(run.artifacts.generatedPath).toBeDefined();
  });

  it('fails a restartPerSpec run at the report stage when the generated DOCX omits the restart', async () => {
    // The 'default' scenario declares no pageNumbering, so its reference DOCX
    // carries no w:pgNumType w:start — standing in for a generator regression
    // that dropped the restart element while still emitting a valid DOCX.
    const docxWithoutRestart = await buildScenarioReferenceDocx(findScenario('default'));
    const apiClient = restartPerSpecClient(() => Promise.resolve(docxWithoutRestart));
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'restartPerSpec' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('report');
    expect(run.error?.message).toContain('w:pgNumType');
    // Generation itself succeeded; only the OOXML postcondition failed.
    expect(run.artifacts.generatedPath).toBeDefined();
  });

  it('fails the import stage when the provisioned section is not the scenario section', async () => {
    const apiClient = stubApiClient({
      addSectionToProject: () =>
        Promise.resolve({
          specId: 'project-spec-1',
          section: '99 99 99',
          position: 1,
          source: { libraryId: 'library-1', name: 'fixture library' },
        }),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('import');
    expect(run.error?.message).toContain('99 99 99');
    expect(run.error?.message).toContain(DEFAULT_SCENARIO_SECTION);
    // Never reaches header/footer config once the section identity fails.
    expect(run.artifacts.headerFooterConfigId).toBeUndefined();
  });

  it('fails the import stage when the provisioned section is sourced from a different library', async () => {
    const apiClient = stubApiClient({
      addSectionToProject: () =>
        Promise.resolve({
          specId: 'project-spec-1',
          section: DEFAULT_SCENARIO_SECTION,
          position: 1,
          source: { libraryId: 'some-other-library', name: 'unexpected library' },
        }),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('import');
    expect(run.error?.message).toContain('some-other-library');
    expect(run.artifacts.headerFooterConfigId).toBeUndefined();
  });

  it('fails the import stage when the header/footer config is anchored to a different project', async () => {
    const apiClient = stubApiClient({
      putProjectHeaderFooter: () =>
        Promise.resolve({
          id: 'hf-config-1',
          scope: { kind: 'project', projectId: 'someone-elses-project' },
          config: {},
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
        }),
    });
    const pipeline = createHeaderFooterFixturePipeline({ apiClient, runStore });

    const runId = pipeline.startRun({ scenarioId: 'default' });

    await waitFor(() => runStore.getRun(runId)?.status === 'failed');

    const run = runStore.getRun(runId);
    if (run === undefined) throw new Error('run missing after failure');
    expect(run.error?.stage).toBe('import');
    expect(run.error?.message).toContain('someone-elses-project');
    expect(run.error?.message).toContain('project-1');
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
