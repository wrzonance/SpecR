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

// #604: trackPending/waitForIdle let a lifecycle owner (e.g. a test's
// afterEach) drain a detached run's outstanding async work before removing
// workRoot out from under it. Deliberately not testing "the internal Set
// self-cleans" as its own case — that's an internal-memory concern, not a
// boundary invariant (see repo convention: test module boundaries, not
// internals); it's exercised implicitly by every waitForIdle call below
// actually settling rather than hanging.
describe('run-store (trackPending / waitForIdle — #604)', () => {
  let workRoot: string;
  let store: RunStore;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-run-store-pending-'));
    store = createRunStore(workRoot);
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('trackPending never throws and never produces an unhandled rejection for a rejecting promise', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      expect(() => {
        store.trackPending(Promise.reject(new Error('boom')));
      }).not.toThrow();

      await store.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }
  });

  it('waitForIdle resolves once every tracked promise has settled, and never rejects even when one rejects', async () => {
    let resolveA: () => void = () => {
      throw new Error('resolveA not assigned');
    };
    const pending = new Promise<void>((resolve) => {
      resolveA = resolve;
    });

    store.trackPending(pending);
    store.trackPending(Promise.reject(new Error('a rejecting tracked promise')));

    let settled = false;
    const idle = store.waitForIdle().then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    resolveA();
    await idle;

    expect(settled).toBe(true);
  });

  it('waitForIdle snapshots the pending set at call time — work tracked after the call is not awaited by it', async () => {
    let resolveA: () => void = () => {
      throw new Error('resolveA not assigned');
    };
    const pendingA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    store.trackPending(pendingA);

    const idle = store.waitForIdle();

    // Registered after waitForIdle() was already called — must not be
    // required to settle for `idle` to resolve.
    const pendingB = new Promise<void>(() => {
      /* never settles */
    });
    store.trackPending(pendingB);

    resolveA();
    await expect(idle).resolves.toBeUndefined(); // resolves despite pendingB being permanently unsettled
  });

  it('waitForIdle no-ops immediately when nothing is pending', async () => {
    await expect(store.waitForIdle()).resolves.toBeUndefined();
  });
});
