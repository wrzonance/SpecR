// Wiring smoke tests for the harness's Express app (#150, task 6/8):
// createApp() mounts the run + file routers under /api/runs, serves the
// docx-preview/jszip UMD bundles this package depends on directly out of
// its own node_modules (paths confirmed reachable by the WT-150 spike), and
// never lets an unmatched route or a thrown error escape as anything but a
// JSON body — no stack trace, no Express default HTML error page.

import { type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api-client/client.js';
import { createRunStore, type RunStore } from '../run/run-store.js';
import { createPipeline } from '../run/pipeline.js';
import { createApp } from './app.js';

describe('createApp (wiring smoke tests)', () => {
  let workRoot: string;
  let runStore: RunStore;
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    workRoot = mkdtempSync(path.join(tmpdir(), 'specr-verify-app-'));
    runStore = createRunStore(workRoot);
    const apiClient = createApiClient({ baseUrl: 'http://localhost:3000' });
    const pipeline = createPipeline({ apiClient, runStore });
    app = createApp({ pipeline, runStore });

    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('server did not bind to a port');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('mounts the runs router under /api/runs', async () => {
    const response = await fetch(`${baseUrl}/api/runs/does-not-exist`);
    expect(response.status).toBe(404);
  });

  it('mounts the files router under the same /api/runs prefix', async () => {
    runStore.createRun({ runId: 'run-1', referenceFilename: 'reference.docx' });

    const response = await fetch(`${baseUrl}/api/runs/run-1/files/not-a-real-file.png`);
    expect(response.status).toBe(404);
  });

  it('serves the docx-preview UMD bundle from its own node_modules', async () => {
    const response = await fetch(`${baseUrl}/vendor/docx-preview.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('docx-preview');
  });

  it('serves the jszip UMD bundle from its own node_modules', async () => {
    const response = await fetch(`${baseUrl}/vendor/jszip.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('JSZip');
  });

  it('serves the harness page at GET / with the pane/sidebar/report automation hooks (task 7/8)', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const body = await response.text();
    expect(body).toContain('data-testid="pane-reference"');
    expect(body).toContain('data-testid="pane-roundtrip"');
    expect(body).toContain('data-testid="pane-diff"');
    expect(body).toContain('data-testid="properties-sidebar"');
    expect(body).toContain('data-testid="derivation-report"');
    expect(body).toContain('/harness.js');
  });

  it('serves harness.js exposing the render/measure hooks with no in-page screenshot capture', async () => {
    const response = await fetch(`${baseUrl}/harness.js`);
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('window.__loadPane');
    expect(body).toContain('window.__measure');
    expect(body).toContain('window.__regionGeom');
    // Confirmed non-viable by the WT-150 spike (blank/gray canvas output in
    // Chromium) — never shipped as a working default (design decision 2).
    // The real capture path is external Playwright -> POST
    // /api/runs/:runId/screenshot, exercised by routes/runs.ts already.
    expect(body).not.toContain('window.__captureScreenshot');
    // Decision 7 (flow-mode rendering) is a locked render option on both
    // panes now, not a query-string toggle like the spike's ignoreLRPB param.
    expect(body).toContain('ignoreLastRenderedPageBreak: true');
  });

  it('answers a generic JSON 404 for any unmatched route, never an HTML error page', async () => {
    const response = await fetch(`${baseUrl}/nonexistent-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('accepts a JSON body large enough for a real full-page screenshot', async () => {
    runStore.createRun({ runId: 'run-2', referenceFilename: 'reference.docx' });
    // ~2 MB of base64 text — far past express's 100kb default limit, well
    // under this app's raised ceiling.
    const bigPayload = 'A'.repeat(2 * 1024 * 1024);

    const response = await fetch(`${baseUrl}/api/runs/run-2/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pane: 'reference', imageBase64: bigPayload }),
    });

    // Not a valid PNG, so this is expected to 422 on content — the point is
    // that it is NOT rejected upstream as "payload too large".
    expect(response.status).toBe(422);
  });

  describe('errorHandler (HTTP transport boundary)', () => {
    it('passes through a client error status (malformed JSON) instead of flattening it to 500', async () => {
      // express.json() throws a body-parser SyntaxError carrying its own
      // `.status = 400` before any route handler runs — this pins that the
      // real client-error status survives, mirroring
      // src/api/middleware/error.ts's `err.status ?? 500` passthrough.
      const response = await fetch(`${baseUrl}/api/runs/does-not-exist`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ this is not valid JSON',
      });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(400);
      expect(body).toEqual({ success: false, error: 'internal server error' });
    });

    it('answers 400 for a multer file-size-limit rejection, passing through its message only', async () => {
      runStore.createRun({ runId: 'run-3', referenceFilename: 'reference.docx' });
      const overLimitFile = Buffer.alloc(10 * 1024 * 1024 + 1);
      const form = new FormData();
      form.append('file', new Blob([overLimitFile]), 'reference.docx');

      const response = await fetch(`${baseUrl}/api/runs`, { method: 'POST', body: form });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.error).not.toContain('.ts:');
      expect(body.error).not.toContain('at ');
    });

    it('answers a generic 500 without leaking internals when a handler-level fs write throws', async () => {
      // Deletes the run's own work directory out from under it, so
      // routes/runs.ts's writeFileSync (writeScreenshot) throws a raw,
      // unwrapped ENOENT synchronously inside submitScreenshotHandler — the
      // exact "disk I/O fails mid-handler" scenario this middleware exists
      // to contain.
      runStore.createRun({ runId: 'run-4', referenceFilename: 'reference.docx' });
      rmSync(runStore.runDir('run-4'), { recursive: true, force: true });
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

      const response = await fetch(`${baseUrl}/api/runs/run-4/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pane: 'reference', imageBase64: pngBytes.toString('base64') }),
      });
      const body = (await response.json()) as { success: boolean; error: string };

      expect(response.status).toBe(500);
      expect(body).toEqual({ success: false, error: 'internal server error' });
      expect(JSON.stringify(body)).not.toContain('ENOENT');
    });
  });
});
