// Invariant tests for the guarded file-serving route (#150, task 6/8):
// resolveRunFilePath must resolve a path ONLY inside a real run's own
// work/<runId>/ directory, gated by FileNameParamSchema's closed enum — any
// filename outside that enum, any unknown/never-created runId, or any
// traversal attempt embedded in either param must resolve to null, and the
// mounted route must answer with a generic 404 in every such case. This is
// the single safety boundary the file-serving route (GET
// /api/runs/:runId/files/:filename, see filename.ts's docstring) rests on —
// never a filesystem read outside the run's sandbox.

import { type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunStore, type RunStore } from '../../run/run-store.js';
import { createFilesRouter, resolveRunFilePath, RUN_FILE_NAMES } from './files.js';

async function listenOn(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

describe('resolveRunFilePath (pure boundary function)', () => {
  let workRoot: string;
  let runStore: RunStore;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-files-'));
    runStore = createRunStore(workRoot);
    runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });
  });

  afterEach(() => {
    rmSync(workRoot, { recursive: true, force: true });
  });

  it.each(RUN_FILE_NAMES)('resolves every known artifact filename (%s) for a real run', (name) => {
    expect(resolveRunFilePath(runStore, 'run-1', name)).toBe(path.join(workRoot, 'run-1', name));
  });

  it.each([
    'not-a-real-artifact.png',
    'reference.doc',
    'REFERENCE.DOCX',
    '',
    '../reference.docx',
    '../../etc/passwd',
    '/etc/passwd',
    'reference.docx/../../../etc/passwd',
    'reference.docx\0.png',
  ])('returns null for a filename outside the closed enum (%s)', (filename) => {
    expect(resolveRunFilePath(runStore, 'run-1', filename)).toBeNull();
  });

  it('returns null for a runId that was never created', () => {
    expect(resolveRunFilePath(runStore, 'does-not-exist', 'reference.docx')).toBeNull();
  });

  it.each(['../run-1', '../../etc', '/etc', 'run-1/../../etc'])(
    'returns null for a traversal-shaped runId (%s), even naming a valid filename',
    (runId) => {
      expect(resolveRunFilePath(runStore, runId, 'reference.docx')).toBeNull();
    }
  );

  it('every resolved path stays strictly inside that run’s own work directory', () => {
    const runDir = path.join(workRoot, 'run-1');
    for (const name of RUN_FILE_NAMES) {
      const resolved = resolveRunFilePath(runStore, 'run-1', name);
      expect(resolved).not.toBeNull();
      expect(path.relative(runDir, resolved as string).startsWith('..')).toBe(false);
    }
  });

  it('never resolves a file belonging to a different run', () => {
    runStore.createRun({ runId: 'run-2', referenceFilename: 'reference.docx' });

    const resolved = resolveRunFilePath(runStore, 'run-1', 'reference.docx');

    expect(resolved).toBe(path.join(workRoot, 'run-1', 'reference.docx'));
    expect(resolved).not.toBe(path.join(workRoot, 'run-2', 'reference.docx'));
  });
});

describe('createFilesRouter (HTTP boundary)', () => {
  let workRoot: string;
  let runStore: RunStore;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-files-http-'));
    runStore = createRunStore(workRoot);
    runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });
    writeFileSync(path.join(workRoot, 'run-1', 'reference.docx'), 'docx bytes');

    app = express();
    app.use('/api/runs', createFilesRouter(runStore));
    const listening = await listenOn(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('serves an existing artifact file with a 200', async () => {
    const response = await fetch(`${baseUrl}/api/runs/run-1/files/reference.docx`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('docx bytes');
  });

  it('answers 404 for a filename outside the closed enum, never touching the filesystem outside the sandbox', async () => {
    const response = await fetch(`${baseUrl}/api/runs/run-1/files/..%2f..%2fetc%2fpasswd`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('answers 404 for an unknown runId', async () => {
    const response = await fetch(`${baseUrl}/api/runs/does-not-exist/files/reference.docx`);

    expect(response.status).toBe(404);
  });

  it('answers 404 for a known filename that has not been produced yet on disk', async () => {
    const response = await fetch(`${baseUrl}/api/runs/run-1/files/generated.docx`);

    expect(response.status).toBe(404);
  });
});

// Regression test for a real bug this task's own dev environment hit: this
// repo is routinely checked out into a dot-prefixed git worktree path (see
// CLAUDE.md/workflow.md's `.worktrees/...` convention) — and express's
// `send` module 404s any res.sendFile() whose path has a DOT-PREFIXED
// ANCESTOR directory by default (dotfiles: 'ignore'), regardless of the
// requested file itself. Without `{ dotfiles: 'allow' }`, a run's real
// work/<runId>/ directory would silently 404 every file it ever served,
// purely because of where the repo happens to be checked out.
describe('serveRunFile under a dot-prefixed ancestor directory (regression)', () => {
  let dotAncestorRoot: string;
  let runStore: RunStore;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dotAncestorRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-files-dotdir-'));
    const workRoot = path.join(dotAncestorRoot, '.worktrees', 'feat-issue-150', 'tools', 'verify');
    mkdirSync(workRoot, { recursive: true });
    runStore = createRunStore(workRoot);
    runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });
    writeFileSync(path.join(workRoot, 'run-1', 'reference.docx'), 'docx bytes');

    app = express();
    app.use('/api/runs', createFilesRouter(runStore));
    const listening = await listenOn(app);
    server = listening.server;
    baseUrl = listening.baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dotAncestorRoot, { recursive: true, force: true });
  });

  it('still serves the file with a 200, not a 404, despite the .worktrees ancestor segment', async () => {
    const response = await fetch(`${baseUrl}/api/runs/run-1/files/reference.docx`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('docx bytes');
  });
});
