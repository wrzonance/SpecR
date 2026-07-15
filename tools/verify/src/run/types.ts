// Run-domain types for the visual round-trip verification harness (#150,
// task 4/8). A RunRecord tracks one end-to-end verification run through the
// pipeline stages RUN_STAGES enumerates in errors.ts; this task's own
// orchestrator (pipeline.ts) only drives a run through 'generate' — per
// issue #150 design decision 3, rendering/measuring/screenshotting/diffing
// are separate explicit stages, driven by later tasks that extend the same
// RunRecord via run-store.ts's updateRun().

import type { RunError, RunStage } from '../errors.js';
import type { DerivationReport, SectionNumberFormat } from '../api-client/schemas.js';

/**
 * Status of the run's *current* `stage` (not the whole multi-stage run):
 * 'running' while that stage is in flight, 'complete' once it finishes
 * successfully, 'failed' once any stage errors (stage stays at the one
 * that failed, matching RunError.stage).
 */
export type RunStatus = 'running' | 'complete' | 'failed';

/** Caller-supplied parameters for a new verification run. */
export interface StartRunOptions {
  readonly section?: string;
  readonly title?: string;
  readonly sectionNumberFormat?: SectionNumberFormat;
}

/**
 * Artifacts accumulated as a run progresses. `referencePath` is always
 * present (deterministic from runId at creation time — see run-store.ts's
 * createRun); every other field is populated only once its producing stage
 * completes. Later tasks (render/measure/screenshot/diff/report) extend
 * this interface with their own fields as those stages land.
 */
export interface RunArtifacts {
  /** work/<runId>/reference.docx — the uploaded reference file (stage: upload). */
  readonly referencePath: string;
  /** POST /parse's async job id (stage: upload). */
  readonly jobId?: string;
  /** The parsed spec's id, from the completed parse job (stage: parse). */
  readonly specId?: string;
  /** The style template derived from the reference file (stage: import). */
  readonly templateId?: string;
  /** WT-3 style-derivation audit returned alongside the template (stage: import). */
  readonly derivationReport?: DerivationReport;
  /** work/<runId>/generated.docx — the round-tripped output (stage: generate). */
  readonly generatedPath?: string;
}

/**
 * One end-to-end verification run. Every mutation run-store.ts applies is a
 * read-modify-write into a brand-new RunRecord — never a mutation of an
 * existing record or its nested `artifacts` in place.
 */
export interface RunRecord {
  readonly runId: string;
  readonly status: RunStatus;
  readonly stage: RunStage;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly referenceFilename: string;
  readonly section?: string;
  readonly title?: string;
  readonly artifacts: RunArtifacts;
  readonly error?: RunError;
}
