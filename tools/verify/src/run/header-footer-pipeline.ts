// Header/footer fixture pipeline for the visual round-trip verification
// harness's header/footer capstone (#305, task 6/7).
//
// Mirrors run/pipeline.ts's fire-and-forget shape exactly (startRun()
// creates the RunRecord synchronously and returns its runId immediately;
// the real work happens in executeFixtureRun(), invoked with `void`) but
// drives a DIFFERENT provisioning path — per issue #305 design decision 5,
// a header/footer scenario has no reference file of its own to upload and
// parse. Instead it is built from the fixture catalog
// (fixtures/header-footer-scenarios.ts) and provisioned through the real
// library/project onboarding surface: create a client library -> import the
// scenario's own reference DOCX into it -> create a project sourced from
// that library -> add the scenario's section to the project -> PUT the
// scenario's header/footer composition -> generate. The final generate
// stage reuses pipeline.ts's own runGenerate (with templateId omitted,
// relying on the documented UFGS-Default fallback per decision 6) and
// failRun, so both pipelines share one no-raw-Error-escapes boundary
// (errors.ts's toRunError) rather than duplicating it.
//
// Stage naming reuses RUN_STAGES exactly as the sibling pipeline does:
// library provisioning reports as 'upload' (mirrors library-client.ts's own
// per-method stage), project + header/footer provisioning report as
// 'import' (mirrors project-client.ts's), and the final render reports as
// 'generate' via the shared runGenerate.

import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { RunStage } from '../errors.js';
import { failRun, runGenerate, type PipelineDeps } from './pipeline.js';
import {
  buildScenarioReferenceDocx,
  findScenario,
  type HeaderFooterScenario,
  type HeaderFooterScenarioId,
} from '../fixtures/header-footer-scenarios.js';
import type { RunRecord } from './types.js';

/** Reuses pipeline.ts's PipelineDeps verbatim — same apiClient/runStore shape. */
export type HeaderFooterPipelineDeps = PipelineDeps;

export interface StartHeaderFooterFixtureInput {
  readonly scenarioId: HeaderFooterScenarioId;
}

export interface HeaderFooterFixturePipeline {
  /**
   * Create a RunRecord for `input.scenarioId` and start driving it through
   * library -> project -> header/footer-config -> generate in the
   * background. Returns the new run's id immediately; poll its progress via
   * HeaderFooterPipelineDeps.runStore.getRun(). Never throws synchronously
   * for a scenarioId drawn from the closed HEADER_FOOTER_SCENARIOS catalog.
   */
  startRun(input: StartHeaderFooterFixtureInput): string;
}

function fixtureName(scenario: HeaderFooterScenario, runId: string): string {
  return `verify-${scenario.id}-${runId}`;
}

// Build the scenario's ground-truth reference DOCX, persist it alongside
// this run's other artifacts (mirrors pipeline.ts's runUpload writing
// input.referenceBuffer to the same deterministic referencePath), then
// create a client library and import that reference into it. Reports as
// stage 'upload' throughout, matching library-client.ts's own per-method
// stage.
async function runLibraryProvision(
  deps: HeaderFooterPipelineDeps,
  record: RunRecord,
  scenario: HeaderFooterScenario
): Promise<string> {
  deps.runStore.updateRun(record.runId, { stage: 'upload', status: 'running' });
  const referenceBuffer = await buildScenarioReferenceDocx(scenario);
  await writeFile(record.artifacts.referencePath, referenceBuffer);

  const referenceFilename = `${scenario.id}-reference.docx`;
  const library = await deps.apiClient.createClientLibrary(fixtureName(scenario, record.runId));
  const jobId = await deps.apiClient.importLibraryMaster(
    library.id,
    referenceBuffer,
    referenceFilename
  );
  await deps.apiClient.waitForLibraryImportJob(jobId);

  deps.runStore.updateRun(record.runId, {
    stage: 'upload',
    status: 'complete',
    artifacts: { libraryId: library.id },
  });
  return library.id;
}

interface ProjectProvisionResult {
  readonly projectId: string;
  readonly projectSpecId: string;
}

// Create a project sourced from the just-imported library and add the
// scenario's own section to it. Reports as stage 'import', matching
// project-client.ts's own per-method stage.
async function runProjectProvision(
  deps: HeaderFooterPipelineDeps,
  runId: string,
  scenario: HeaderFooterScenario,
  libraryId: string
): Promise<ProjectProvisionResult> {
  deps.runStore.updateRun(runId, { stage: 'import', status: 'running' });
  const { projectId } = await deps.apiClient.createProject(fixtureName(scenario, runId), [
    libraryId,
  ]);
  const added = await deps.apiClient.addSectionToProject(projectId, scenario.section);

  deps.runStore.updateRun(runId, {
    stage: 'import',
    status: 'complete',
    artifacts: { projectId, projectSpecId: added.specId },
  });
  return { projectId, projectSpecId: added.specId };
}

// PUT the scenario's own header/footer composition onto the provisioned
// project. Also reports as stage 'import' — a distinct sub-step from
// project provisioning above, but the same RunStage (see this module's
// docstring).
async function runHeaderFooterConfig(
  deps: HeaderFooterPipelineDeps,
  runId: string,
  scenario: HeaderFooterScenario,
  projectId: string
): Promise<void> {
  deps.runStore.updateRun(runId, { stage: 'import', status: 'running' });
  const config = await deps.apiClient.putProjectHeaderFooter(projectId, scenario.composition);

  deps.runStore.updateRun(runId, {
    stage: 'import',
    status: 'complete',
    artifacts: { headerFooterConfigId: config.id },
  });
}

// Delegates straight to pipeline.ts's own runGenerate: templateId is always
// omitted (decision 6 — the documented UFGS-Default fallback), and
// projectSpecId stands in for the main pipeline's specId param.
function runFixtureGenerate(
  deps: HeaderFooterPipelineDeps,
  runId: string,
  projectSpecId: string
): Promise<void> {
  return runGenerate(deps, runId, projectSpecId, undefined, undefined);
}

async function executeFixtureRun(
  deps: HeaderFooterPipelineDeps,
  record: RunRecord,
  scenario: HeaderFooterScenario
): Promise<void> {
  let stage: RunStage = 'upload';
  try {
    const libraryId = await runLibraryProvision(deps, record, scenario);
    stage = 'import';
    const { projectId, projectSpecId } = await runProjectProvision(
      deps,
      record.runId,
      scenario,
      libraryId
    );
    await runHeaderFooterConfig(deps, record.runId, scenario, projectId);
    stage = 'generate';
    await runFixtureGenerate(deps, record.runId, projectSpecId);
  } catch (err) {
    failRun(deps, record.runId, stage, err);
  }
}

export function createHeaderFooterFixturePipeline(
  deps: HeaderFooterPipelineDeps
): HeaderFooterFixturePipeline {
  function startRun(input: StartHeaderFooterFixtureInput): string {
    const scenario = findScenario(input.scenarioId);
    const runId = randomUUID();
    const record = deps.runStore.createRun({
      runId,
      referenceFilename: `${scenario.id}-reference.docx`,
      section: scenario.section,
      title: scenario.title,
    });
    void executeFixtureRun(deps, record, scenario);
    return record.runId;
  }

  return { startRun };
}
