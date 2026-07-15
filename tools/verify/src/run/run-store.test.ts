// Invariant tests for run-store.ts (#150, task 4/8): every RunRecord
// mutation must be a read-modify-write into a brand-new object — never a
// mutation of an existing RunRecord or its nested `artifacts` in place.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunStore, type RunStore } from './run-store.js';
import type { RunRecord } from './types.js';

describe('run-store (immutability + manifest persistence)', () => {
  let workRoot: string;
  let store: RunStore;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-run-store-'));
    store = createRunStore(workRoot);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('createRun returns a RunRecord with a deterministic referencePath and initial upload stage', () => {
    const record = store.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

    expect(record.runId).toBe('run-1');
    expect(record.status).toBe('running');
    expect(record.stage).toBe('upload');
    expect(record.artifacts.referencePath).toBe(path.join(workRoot, 'run-1', 'reference.docx'));
  });

  it('updateRun never mutates the previously-returned RunRecord in place', () => {
    const original = store.createRun({ runId: 'run-2', referenceFilename: 'reference.docx' });
    const originalSnapshot: RunRecord = { ...original, artifacts: { ...original.artifacts } };

    const updated = store.updateRun('run-2', { stage: 'parse', status: 'complete' });

    expect(updated).not.toBe(original);
    expect(original).toEqual(originalSnapshot);
    expect(original.stage).toBe('upload');
    expect(original.status).toBe('running');
    expect(updated.stage).toBe('parse');
    expect(updated.status).toBe('complete');
  });

  it('updateRun never mutates the previous artifacts object when merging in new fields', () => {
    const created = store.createRun({ runId: 'run-3', referenceFilename: 'reference.docx' });
    const originalArtifacts = created.artifacts;

    const updated = store.updateRun('run-3', { artifacts: { jobId: 'job-1' } });

    expect(updated.artifacts).not.toBe(originalArtifacts);
    expect(originalArtifacts).toEqual({ referencePath: created.artifacts.referencePath });
    expect('jobId' in originalArtifacts).toBe(false);
    expect(updated.artifacts).toEqual({
      referencePath: created.artifacts.referencePath,
      jobId: 'job-1',
    });
  });

  it('accumulates artifacts across multiple updates without dropping earlier fields', () => {
    store.createRun({ runId: 'run-4', referenceFilename: 'reference.docx' });
    store.updateRun('run-4', { artifacts: { jobId: 'job-1' } });
    const updated = store.updateRun('run-4', { artifacts: { specId: 'spec-1' } });

    expect(updated.artifacts.jobId).toBe('job-1');
    expect(updated.artifacts.specId).toBe('spec-1');
  });

  it('getRun returns the latest record, never a stale earlier snapshot', () => {
    store.createRun({ runId: 'run-5', referenceFilename: 'reference.docx' });
    store.updateRun('run-5', { status: 'complete' });

    expect(store.getRun('run-5')?.status).toBe('complete');
  });

  it('getRun returns undefined for an unknown runId', () => {
    expect(store.getRun('does-not-exist')).toBeUndefined();
  });

  it('updateRun throws on an unknown runId rather than silently no-oping', () => {
    expect(() => store.updateRun('does-not-exist', { status: 'failed' })).toThrow();
  });

  it('persists a manifest.json snapshot matching the latest RunRecord after every mutation', () => {
    store.createRun({ runId: 'run-6', referenceFilename: 'reference.docx' });
    const updated = store.updateRun('run-6', { stage: 'generate', status: 'complete' });

    const manifestFile = path.join(workRoot, 'run-6', 'manifest.json');
    expect(existsSync(manifestFile)).toBe(true);
    expect(JSON.parse(readFileSync(manifestFile, 'utf8'))).toEqual(updated);
  });
});
