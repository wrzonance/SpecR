import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);

  await new Promise<void>((resolveListen) => {
    server = app.listen(0, () => resolveListen());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => (err != null ? reject(err) : resolveClose()));
  });
  await pool.end();
});

interface WarningShape {
  type: string;
  lineHint?: string;
  suggestion?: string;
}

interface JobResult {
  specId: string;
  section: string;
  title: string;
  nodeCount: number;
  capabilities?: string[];
  warnings?: WarningShape[];
}

interface JobData {
  status: string;
  result?: JobResult;
  error?: string;
}

async function waitForJob(jobId: string, maxMs = 20_000): Promise<JobData> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/parse/jobs/${jobId}`);
    const body = (await res.json()) as { success: boolean; data: JobData };
    const job = body.data;
    if (job.status === 'complete' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`job ${jobId} did not complete within ${maxMs}ms`);
}

async function postFixtureForParse(fixturePath: string, filename: string): Promise<string> {
  const fixture = readFileSync(resolve(fixturePath));
  const form = new FormData();
  form.append('file', new Blob([fixture], { type: 'text/plain' }), filename);
  const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  expect(postRes.status).toBe(202);
  const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
  return postBody.data.jobId;
}

function assertEmptyPartAnomaly(result: JobResult | undefined): void {
  if (result === undefined) throw new Error('expected job result to be defined');
  const warnings = result.warnings ?? [];
  expect(Array.isArray(warnings)).toBe(true);
  expect(warnings.length).toBeGreaterThan(0);
  expect(warnings.some((w) => w.type === 'empty-part')).toBe(true);
  expect(result.capabilities ?? []).toContain('parse-warnings');
  expect(result.nodeCount).toBeGreaterThan(3);
}

describe('POST /parse — parse-warnings integration', () => {
  it('surfaces empty-part warning and parse-warnings capability for anomaly fixture', async () => {
    const jobId = await postFixtureForParse(
      'tests/fixtures/text/anomaly-empty-part.txt',
      'anomaly-empty-part.txt'
    );
    const job = await waitForJob(jobId);
    expect(job.status).toBe('complete');

    const specId = job.result?.specId;
    if (specId) {
      await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
    }

    assertEmptyPartAnomaly(job.result);
  }, 30_000);
});
