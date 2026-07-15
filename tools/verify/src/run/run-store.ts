// In-memory RunRecord store with manifest.json persistence under
// work/<runId>/ (#150, task 4/8). Mirrors src/lib/jobs.ts's synchronous
// create/update/get shape; unlike jobs.ts, every mutation also snapshots the
// record to disk so a run's last-known state survives a harness restart.
//
// Every mutation is a read-modify-write into a brand-new RunRecord —
// createRun and updateRun never mutate an existing record or its nested
// `artifacts` in place.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunError, RunStage } from '../errors.js';
import type { RunArtifacts, RunRecord, RunStatus } from './types.js';

// tools/verify/work/ — this package's gitignored local working directory
// (see .gitignore, issue #150 design decision 5). Resolved from this
// module's own location so it is correct whether running from src (tsx) or
// dist (tsc build), regardless of the process's cwd.
const DEFAULT_WORK_ROOT = path.resolve(import.meta.dirname, '../../work');

export interface CreateRunInput {
  readonly runId: string;
  readonly referenceFilename: string;
  readonly section?: string;
  readonly title?: string;
}

export interface UpdateRunPatch {
  readonly status?: RunStatus;
  readonly stage?: RunStage;
  readonly artifacts?: Partial<RunArtifacts>;
  readonly error?: RunError;
}

export interface RunStore {
  readonly workRoot: string;
  runDir(runId: string): string;
  createRun(input: CreateRunInput): RunRecord;
  updateRun(runId: string, patch: UpdateRunPatch): RunRecord;
  getRun(runId: string): RunRecord | undefined;
}

function manifestPath(runDir: string): string {
  return path.join(runDir, 'manifest.json');
}

// Snapshot a RunRecord to work/<runId>/manifest.json. Synchronous, like the
// rest of this store's API — see createRunStore's docstring for why.
function persistManifest(runDir: string, record: RunRecord): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(manifestPath(runDir), JSON.stringify(record, null, 2), 'utf8');
}

function buildRecord(input: CreateRunInput, referencePath: string): RunRecord {
  const now = Date.now();
  return {
    runId: input.runId,
    status: 'running',
    stage: 'upload',
    startedAt: now,
    updatedAt: now,
    referenceFilename: input.referenceFilename,
    ...(input.section !== undefined ? { section: input.section } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    artifacts: { referencePath },
  };
}

function applyPatch(existing: RunRecord, patch: UpdateRunPatch): RunRecord {
  return {
    ...existing,
    updatedAt: Date.now(),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
    ...(patch.artifacts !== undefined
      ? { artifacts: { ...existing.artifacts, ...patch.artifacts } }
      : {}),
    ...(patch.error !== undefined ? { error: patch.error } : {}),
  };
}

/**
 * Create an isolated RunRecord store rooted at `workRoot` (default:
 * tools/verify/work/). All mutation methods are synchronous — the manifest
 * writes are small, infrequent JSON snapshots, and synchronous fs avoids a
 * whole class of write-ordering races between a run's own sequential stages
 * without needing every store call in pipeline.ts to be awaited. Tests
 * inject a temp directory so they never touch the real one.
 */
export function createRunStore(workRoot: string = DEFAULT_WORK_ROOT): RunStore {
  const runs = new Map<string, RunRecord>();

  function runDir(runId: string): string {
    return path.join(workRoot, runId);
  }

  function createRun(input: CreateRunInput): RunRecord {
    const record = buildRecord(input, path.join(runDir(input.runId), 'reference.docx'));
    runs.set(record.runId, record);
    persistManifest(runDir(record.runId), record);
    return record;
  }

  function updateRun(runId: string, patch: UpdateRunPatch): RunRecord {
    const existing = runs.get(runId);
    if (!existing) {
      throw new Error(`run-store: no such run: ${runId}`);
    }
    const updated = applyPatch(existing, patch);
    runs.set(runId, updated);
    persistManifest(runDir(runId), updated);
    return updated;
  }

  function getRun(runId: string): RunRecord | undefined {
    return runs.get(runId);
  }

  return { workRoot, runDir, createRun, updateRun, getRun };
}
