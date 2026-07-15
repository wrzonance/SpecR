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
});
