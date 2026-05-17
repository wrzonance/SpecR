import { v4 as uuidv4 } from 'uuid';

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
