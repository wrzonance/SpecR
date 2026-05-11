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

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
  await pool.end();
});

interface JobResult {
  specId: string;
  section: string;
  title: string;
  nodeCount: number;
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

function makeFormData(buffer: Buffer, filename: string): FormData {
  const form = new FormData();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  form.append('file', blob, filename);
  return form;
}

describe('POST /parse integration', () => {
  const cleanupIds: string[] = [];

  afterAll(async () => {
    for (const id of cleanupIds) {
      await pool.query('DELETE FROM specs WHERE id = $1', [id]);
    }
  });

  it('parses ARCAT DOCX and stores paragraphs in DB', async () => {
    const buffer = readFileSync(resolve('docs/references/ARCAT/01_10_00arc.docx'));
    const form = makeFormData(buffer, '01_10_00arc.docx');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);

    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    expect(postBody.success).toBe(true);
    const { jobId } = postBody.data;
    expect(typeof jobId).toBe('string');

    const job = await waitForJob(jobId);
    expect(job.status).toBe('complete');
    expect(job.result?.specId).toBeDefined();

    const specId = job.result?.specId;
    if (specId) cleanupIds.push(specId);

    // Spec row exists in DB
    const specResult = await pool.query<{ section: string; source: string }>(
      'SELECT section, source FROM specs WHERE id = $1',
      [specId]
    );
    expect(specResult.rows).toHaveLength(1);
    expect(specResult.rows[0]?.source).toBe('arcat');

    // Paragraphs were inserted
    const paraResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1',
      [specId]
    );
    expect(parseInt(paraResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  }, 30_000);

  it('returns 400 when no file provided', async () => {
    const res = await fetch(`${baseUrl}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('file required');
  });

  it('job fails gracefully for unsupported extension', async () => {
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('fake content')], { type: 'application/pdf' }), 'file.pdf');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);

    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    const { jobId } = postBody.data;

    const job = await waitForJob(jobId);
    expect(job.status).toBe('failed');
    expect(typeof job.error).toBe('string');
  });

  it('GET /parse/jobs/:jobId returns 404 for unknown job', async () => {
    const res = await fetch(`${baseUrl}/parse/jobs/nonexistent-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('job not found');
  });
});
