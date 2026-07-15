// HTTP-boundary tests for the run lifecycle + screenshot-ingestion routes
// (#150, task 6/8). No real pipeline stages run here — Pipeline is stubbed
// (mirrors run/pipeline.test.ts's stubApiClient pattern) so these pin only
// this route layer's own contract: multipart upload -> pipeline.startRun(),
// RunRecord polling, and screenshot ingestion writing the right artifact
// field under the right filename.

import { type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunStore, type RunStore } from '../../run/run-store.js';
import type { Pipeline, StartRunInput } from '../../run/pipeline.js';
import { createRunsRouter } from './runs.js';

// Minimal valid PNG: signature + a single deflate-empty IHDR-less body is
// unnecessary here — only the 8-byte signature is checked, so pad past it.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOT_PNG_BYTES = Buffer.from('not a png');

function stubPipeline(startRun: (input: StartRunInput) => string): Pipeline {
  return { startRun };
}

async function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a port');
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

describe('createRunsRouter (HTTP boundary)', () => {
  let workRoot: string;
  let runStore: RunStore;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-runs-http-'));
    runStore = createRunStore(workRoot);
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workRoot, { recursive: true, force: true });
  });

  function mount(pipeline: Pipeline): Promise<void> {
    app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/runs', createRunsRouter(pipeline, runStore));
    return listen(app).then((result) => {
      server = result.server;
      baseUrl = result.baseUrl;
    });
  }

  describe('POST /api/runs (start)', () => {
    it('starts a run from a multipart upload and returns 202 with the runId', async () => {
      const startRun = vi.fn((_input: StartRunInput) => 'run-1');
      await mount(stubPipeline(startRun));

      const form = new FormData();
      form.append('file', new Blob([Buffer.from('docx bytes')]), 'reference.docx');
      form.append('section', '09 91 26');

      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });
      const body = (await response.json()) as { success: boolean; data: { runId: string } };

      expect(response.status).toBe(202);
      expect(body).toEqual({ success: true, data: { runId: 'run-1' } });
      expect(startRun).toHaveBeenCalledOnce();
      const call = startRun.mock.calls[0];
      if (call === undefined) throw new Error('startRun was not called');
      const [input] = call;
      expect(input.referenceFilename).toBe('reference.docx');
      expect(input.options).toEqual({ section: '09 91 26' });
    });

    it('answers 422 when no file is uploaded', async () => {
      await mount(stubPipeline(() => 'run-1'));

      const form = new FormData();
      form.append('section', '09 91 26');

      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });

      expect(response.status).toBe(422);
    });

    it('answers 422 for an unrecognized sectionNumberFormat', async () => {
      await mount(stubPipeline(() => 'run-1'));

      const form = new FormData();
      form.append('file', new Blob([Buffer.from('docx bytes')]), 'reference.docx');
      form.append('sectionNumberFormat', 'not-a-real-format');

      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });

      expect(response.status).toBe(422);
    });
  });

  describe('GET /api/runs/:runId (poll)', () => {
    it('returns the current RunRecord for a known run', async () => {
      await mount(stubPipeline(() => 'run-1'));
      const created = runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

      const response = await fetch(`${baseUrl}/api/runs/run-1`);
      const body = (await response.json()) as { success: boolean; data: unknown };

      expect(response.status).toBe(200);
      expect(body).toEqual({ success: true, data: created });
    });

    it('answers 404 for an unknown runId', async () => {
      await mount(stubPipeline(() => 'run-1'));

      const response = await fetch(`${baseUrl}/api/runs/does-not-exist`);

      expect(response.status).toBe(404);
    });
  });

  describe('POST /api/runs/:runId/screenshot (primary capture-ingestion path)', () => {
    it('writes the reference pane screenshot and records its artifact path', async () => {
      await mount(stubPipeline(() => 'run-1'));
      runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

      const response = await fetch(`${baseUrl}/api/runs/run-1/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference', imageBase64: PNG_BYTES.toString('base64') }),
      });
      const body = (await response.json()) as {
        success: boolean;
        data: { stage: string; artifacts: { referenceScreenshotPath?: string } };
      };

      expect(response.status).toBe(200);
      expect(body.data.stage).toBe('screenshot');
      const savedPath = body.data.artifacts.referenceScreenshotPath;
      expect(savedPath).toBe(path.join(workRoot, 'run-1', 'reference-screenshot.png'));
      expect(existsSync(savedPath as string)).toBe(true);
      expect(readFileSync(savedPath as string).equals(PNG_BYTES)).toBe(true);
    });

    it('writes the roundtrip pane screenshot under its own artifact field', async () => {
      await mount(stubPipeline(() => 'run-1'));
      runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

      const response = await fetch(`${baseUrl}/api/runs/run-1/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'roundtrip', imageBase64: PNG_BYTES.toString('base64') }),
      });
      const body = (await response.json()) as {
        data: { artifacts: { roundtripScreenshotPath?: string; referenceScreenshotPath?: string } };
      };

      expect(body.data.artifacts.roundtripScreenshotPath).toBe(
        path.join(workRoot, 'run-1', 'roundtrip-screenshot.png')
      );
      expect(body.data.artifacts.referenceScreenshotPath).toBeUndefined();
    });

    it('answers 404 for an unknown runId, never writing to disk', async () => {
      await mount(stubPipeline(() => 'run-1'));

      const response = await fetch(`${baseUrl}/api/runs/does-not-exist/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference', imageBase64: PNG_BYTES.toString('base64') }),
      });

      expect(response.status).toBe(404);
    });

    it('answers 422 when the body is missing required fields', async () => {
      await mount(stubPipeline(() => 'run-1'));
      runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

      const response = await fetch(`${baseUrl}/api/runs/run-1/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference' }),
      });

      expect(response.status).toBe(422);
    });

    it('answers 422 when imageBase64 does not decode to a real PNG', async () => {
      await mount(stubPipeline(() => 'run-1'));
      runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

      const response = await fetch(`${baseUrl}/api/runs/run-1/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference', imageBase64: NOT_PNG_BYTES.toString('base64') }),
      });

      expect(response.status).toBe(422);
      const runDir = path.join(workRoot, 'run-1');
      expect(existsSync(path.join(runDir, 'reference-screenshot.png'))).toBe(false);
    });
  });
});
