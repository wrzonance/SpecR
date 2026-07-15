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
//
// Each provisioning stage additionally asserts the IDENTITY of what the
// backend returned, not just its Zod-validated shape: the parsed
// section/title round-trip (assertScenarioIdentityRoundTripped), the
// provisioned section + source library (assertSectionProvisioned), and the
// header/footer config's project scope (assertHeaderFooterScoped). After
// generate, the restartPerSpec scenario runs one 'report'-stage
// postcondition (assertGeneratedPageNumbering) against the GENERATED DOCX's
// OOXML, because its page-numbering restart is invisible in docx-preview.

import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { VerifyApiError, VerifyRenderError, type RunStage } from '../errors.js';
import { failRun, runGenerate, type PipelineDeps } from './pipeline.js';
import { assertPageNumberingRestart } from '../fixtures/assert-page-numbering.js';
import {
  buildScenarioReferenceDocx,
  findScenario,
  type HeaderFooterScenario,
  type HeaderFooterScenarioId,
} from '../fixtures/header-footer-scenarios.js';
import type {
  AddSectionToProjectResult,
  HeaderFooterConfig,
  OnboardingJobResult,
} from '../api-client/schemas.js';
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

// Enforces this module's own stated invariant — every scenario's built
// reference DOCX round-trips through the REAL parser to its own
// section/title exactly. OnboardingJobResult.section/.title are the
// backend's own resolved values (src/parser/docx/core-metadata.ts's
// parseCoreMetadata, reading the docProps/core.xml this pipeline's
// reference DOCX carries — see header-footer-scenarios.ts's spike-fix
// docstring), never read back from the scenario catalog. Without this
// check the pipeline would silently accept whatever the real parser
// produced: RunRecord.section/.title are seeded from the scenario catalog
// itself at startRun() (see createHeaderFooterFixturePipeline below) and
// never overwritten from the parsed result, so a title/section-resolution
// regression in the real parser would otherwise go undetected end to end.
function assertScenarioIdentityRoundTripped(
  scenario: HeaderFooterScenario,
  result: OnboardingJobResult
): void {
  if (result.section === scenario.section && result.title === scenario.title) return;
  throw new VerifyApiError(
    `header/footer scenario '${scenario.id}' round-tripped through the real parser as ` +
      `section '${result.section}' / title '${result.title}', expected ` +
      `'${scenario.section}' / '${scenario.title}'`,
    { stage: 'upload' }
  );
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
  const onboardingResult = await deps.apiClient.waitForLibraryImportJob(jobId);
  assertScenarioIdentityRoundTripped(scenario, onboardingResult);

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

// The provisioned section must be the scenario's own, sourced from the
// library this run just created. The api-client Zod-validates the response
// SHAPE (schemas.ts) but not its identity, so a backend that added a
// different section — or resolved the section from some other source
// library — would pass silently and the whole run would end up verifying
// the wrong spec. Mirrors assertScenarioIdentityRoundTripped's guard at the
// parse boundary.
function assertSectionProvisioned(
  scenario: HeaderFooterScenario,
  libraryId: string,
  added: AddSectionToProjectResult
): void {
  if (added.section === scenario.section && added.source.libraryId === libraryId) return;
  throw new VerifyApiError(
    `header/footer scenario '${scenario.id}' provisioned section '${added.section}' from library ` +
      `'${added.source.libraryId}', expected section '${scenario.section}' from library '${libraryId}'`,
    { stage: 'import' }
  );
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
  assertSectionProvisioned(scenario, libraryId, added);

  deps.runStore.updateRun(runId, {
    stage: 'import',
    status: 'complete',
    artifacts: { projectId, projectSpecId: added.specId },
  });
  return { projectId, projectSpecId: added.specId };
}

// The returned config must be anchored to the project this run just PUT it
// on. The api-client models all four HeaderFooterScope kinds (schemas.ts)
// and validates only the shape, so a backend that persisted the config at
// the wrong scope — or the wrong project — would round-trip a valid but
// wrong row; this pins it to { kind: 'project', projectId }.
function assertHeaderFooterScoped(
  scenario: HeaderFooterScenario,
  projectId: string,
  config: HeaderFooterConfig
): void {
  const { scope } = config;
  if (scope.kind === 'project' && scope.projectId === projectId) return;
  const found = scope.kind === 'project' ? `project '${scope.projectId}'` : `scope '${scope.kind}'`;
  throw new VerifyApiError(
    `header/footer scenario '${scenario.id}' config anchored to ${found}, expected project '${projectId}'`,
    { stage: 'import' }
  );
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
  assertHeaderFooterScoped(scenario, projectId, config);

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

// #305's restartPerSpec scenario forces a page-numbering restart a human
// reviewer CANNOT see — PAGE fields render empty in docx-preview on both
// panes (documented KNOWN LIMITATION) — so the restart is verified at the
// OOXML level against the GENERATED DOCX, not by pixels. Without this
// postcondition a generator regression that dropped the trailing sectPr's
// w:pgNumType w:start would leave the run 'generate: complete' and look
// fine on screen, so the restartPerSpec scenario would verify nothing. Only
// the restartPerSpec mode carries a restart to assert; every other mode
// no-ops. Reads the generatedPath runGenerate recorded on the RunRecord.
async function assertGeneratedPageNumbering(
  deps: HeaderFooterPipelineDeps,
  runId: string,
  scenario: HeaderFooterScenario
): Promise<void> {
  const { pageNumbering } = scenario.composition;
  if (pageNumbering?.mode !== 'restartPerSpec' || pageNumbering.startAt === undefined) return;
  const generatedPath = deps.runStore.getRun(runId)?.artifacts.generatedPath;
  if (generatedPath === undefined) {
    throw new VerifyRenderError(
      `header/footer scenario '${scenario.id}' finished generate without a generated DOCX ` +
        `to verify page numbering against`,
      { stage: 'report' }
    );
  }
  await assertPageNumberingRestart(await readFile(generatedPath), pageNumbering.startAt);
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
    stage = 'report';
    await assertGeneratedPageNumbering(deps, record.runId, scenario);
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
