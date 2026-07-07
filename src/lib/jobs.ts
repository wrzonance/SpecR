import { v4 as uuidv4 } from 'uuid';
import type { DerivationReport } from '../parser/index.js';
import type { ParseWarning, Editability } from '../ast/index.js';
import type { HierarchySummary } from './hierarchy-summary.js';

export type ParseStage =
  | 'queued'
  | 'running'
  | 'extracting'
  | 'numbering'
  | 'styles'
  | 'document'
  | 'classifying'
  | 'persisting'
  | 'complete'
  | 'failed';

export interface ParseJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly capabilities?: readonly string[];
}

export interface ParseJob {
  readonly jobId: string;
  readonly status: ParseStage;
  readonly progress: { readonly stage: ParseStage; readonly pct: number };
  readonly result?: ParseJobResult;
  readonly error?: string;
  readonly expiresAt: number;
}

const jobs = new Map<string, ParseJob>();
const JOB_TTL_MS = 3_600_000; // 1 hour

export function createJob(): string {
  const jobId = uuidv4();
  jobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: { stage: 'queued', pct: 0 },
    expiresAt: Date.now() + JOB_TTL_MS,
  });
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS).unref();
  return jobId;
}

export function updateJob(
  jobId: string,
  update: {
    readonly status?: ParseStage;
    readonly stage?: ParseStage;
    readonly pct?: number;
    readonly result?: ParseJobResult;
    readonly error?: string;
  }
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.set(jobId, {
    ...job,
    ...(update.status !== undefined ? { status: update.status } : {}),
    progress: {
      stage: update.stage ?? job.progress.stage,
      pct: update.pct ?? job.progress.pct,
    },
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
  });
}

export function getJob(jobId: string): ParseJob | undefined {
  return jobs.get(jobId);
}

// ── Onboarding jobs (O-8) ─────────────────────────────────────────────────────
// A separate store + result contract from parse jobs: the onboarding report has
// three sections (style derivation, editability summary, parse warnings) that do
// not fit ParseJobResult, and /parse/jobs must keep its existing schema.

export type OnboardingStage =
  | 'queued'
  | 'running'
  | 'parsing'
  | 'persisting'
  | 'deriving-style'
  | 'classifying'
  | 'complete'
  | 'failed';

export interface EditabilitySummary {
  /** One count per closed editability value (ADR-022 D1). Always all four keys. */
  readonly counts: Record<Editability, number>;
  /** Classified paragraphs whose machine confidence is below the review threshold. */
  readonly lowConfidence: readonly {
    readonly nodeId: string;
    readonly value: Editability;
    readonly confidence: number;
  }[];
}

export interface OnboardingReport {
  /** WT-3 consensus style derivation audit; null for non-DOCX sources. */
  readonly styleDerivation: DerivationReport | null;
  /** True when no style template was derived (non-DOCX) — assign via O-12 later. */
  readonly styleSourceNeeded: boolean;
  readonly editability: EditabilitySummary;
  /** Hierarchy-inference confidence summary (ADR-055). */
  readonly hierarchy: HierarchySummary;
  readonly parseWarnings: readonly ParseWarning[];
}

export interface OnboardingJobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly libraryId: string;
  /** Derived style template id (DOCX) or null (non-DOCX). */
  readonly templateId: string | null;
  readonly report: OnboardingReport;
}

export interface OnboardingJob {
  readonly jobId: string;
  readonly status: OnboardingStage;
  readonly progress: { readonly stage: OnboardingStage; readonly pct: number };
  readonly result?: OnboardingJobResult;
  readonly error?: string;
  readonly expiresAt: number;
}

const onboardingJobs = new Map<string, OnboardingJob>();

export function createOnboardingJob(): string {
  const jobId = uuidv4();
  onboardingJobs.set(jobId, {
    jobId,
    status: 'queued',
    progress: { stage: 'queued', pct: 0 },
    expiresAt: Date.now() + JOB_TTL_MS,
  });
  setTimeout(() => onboardingJobs.delete(jobId), JOB_TTL_MS).unref();
  return jobId;
}

export function updateOnboardingJob(
  jobId: string,
  update: {
    readonly status?: OnboardingStage;
    readonly stage?: OnboardingStage;
    readonly pct?: number;
    readonly result?: OnboardingJobResult;
    readonly error?: string;
  }
): void {
  const job = onboardingJobs.get(jobId);
  if (!job) return;
  onboardingJobs.set(jobId, {
    ...job,
    ...(update.status !== undefined ? { status: update.status } : {}),
    progress: {
      stage: update.stage ?? job.progress.stage,
      pct: update.pct ?? job.progress.pct,
    },
    ...(update.result !== undefined ? { result: update.result } : {}),
    ...(update.error !== undefined ? { error: update.error } : {}),
  });
}

export function getOnboardingJob(jobId: string): OnboardingJob | undefined {
  return onboardingJobs.get(jobId);
}
