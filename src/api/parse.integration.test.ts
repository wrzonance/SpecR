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
  capabilities?: string[];
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

const cleanupIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  }
});

async function assertUfgsSpecInDb(specId: string): Promise<void> {
  const specResult = await pool.query<{ source: string }>(
    'SELECT source FROM specs WHERE id = $1',
    [specId]
  );
  expect(specResult.rows).toHaveLength(1);
  expect(specResult.rows[0]?.source).toBe('ufgs');
  const paraResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1',
    [specId]
  );
  expect(parseInt(paraResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
}

async function assertFailsForPdf(): Promise<void> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(Buffer.from('x'))], { type: 'application/pdf' }),
    'file.pdf'
  );
  const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  // Security hardening (issue #22): unsupported extensions now rejected at the handler
  // before createJob — returns 400, no job created.
  expect(postRes.status).toBe(400);
  const postBody = (await postRes.json()) as { success: boolean; error: string; data?: unknown };
  expect(postBody.success).toBe(false);
  expect(typeof postBody.error).toBe('string');
  expect(postBody.data).toBeUndefined();
}

describe('POST /parse integration', () => {
  it('parses UFGS .sec file and stores paragraphs in DB', async () => {
    // Use UFGS .sec fixture — public domain, tracked in git, available in CI.
    const secContent = readFileSync(
      resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'),
      'utf-8'
    );
    const form = new FormData();
    form.append('file', new Blob([secContent], { type: 'text/plain' }), '01_11_00.sec');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);

    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    const { jobId } = postBody.data;
    expect(typeof jobId).toBe('string');

    const job = await waitForJob(jobId);
    expect(job.status).toBe('complete');

    const specId = job.result?.specId;
    expect(specId).toBeDefined();
    if (specId) {
      cleanupIds.push(specId);
      await assertUfgsSpecInDb(specId);
    }
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
    await assertFailsForPdf();
  });

  it('GET /parse/jobs/:jobId returns 404 for unknown job', async () => {
    const res = await fetch(`${baseUrl}/parse/jobs/nonexistent-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('job not found');
  });
});

describe('POST /parse — refs persistence + replace-on-reparse (#53)', () => {
  async function postSecFixture(): Promise<string> {
    const secContent = readFileSync(
      resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'),
      'utf-8'
    );
    const form = new FormData();
    form.append('file', new Blob([secContent], { type: 'text/plain' }), '01_11_00.sec');
    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    const job = await waitForJob(postBody.data.jobId);
    expect(job.status).toBe('complete');
    const specId = job.result?.specId;
    if (!specId) throw new Error('expected specId in completed job result');
    return specId;
  }

  it('persists spec_references rows on API path (SEC fixture with SRF tags)', async () => {
    // Ensure clean slate — delete any spec from a previous test run that used the same fixture.
    await pool.query(`DELETE FROM specs WHERE section = '01 11 00' AND source = 'ufgs'`);
    const specId = await postSecFixture();
    cleanupIds.push(specId);

    const refsResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1',
      [specId]
    );
    const refCount = parseInt(refsResult.rows[0]?.count ?? '0', 10);
    expect(refCount).toBeGreaterThan(0);
  }, 30_000);

  it('re-POST same fixture returns same specId (upsert) and replaces paragraphs + refs', async () => {
    await pool.query(`DELETE FROM specs WHERE section = '01 11 00' AND source = 'ufgs'`);
    const firstSpecId = await postSecFixture();
    cleanupIds.push(firstSpecId);

    const firstParaIds = await pool.query<{ id: string }>(
      'SELECT id FROM paragraphs WHERE spec_id = $1 ORDER BY id',
      [firstSpecId]
    );
    expect(firstParaIds.rows.length).toBeGreaterThan(0);

    const secondSpecId = await postSecFixture();
    // Upsert: same row, same id.
    expect(secondSpecId).toBe(firstSpecId);

    const secondParaIds = await pool.query<{ id: string }>(
      'SELECT id FROM paragraphs WHERE spec_id = $1 ORDER BY id',
      [secondSpecId]
    );
    // Replace-on-reparse: old paragraph ids gone, new ids present.
    const firstSet = new Set(firstParaIds.rows.map((r) => r.id));
    const overlap = secondParaIds.rows.filter((r) => firstSet.has(r.id));
    expect(overlap).toEqual([]);

    // Refs still present after re-upload (deleted + reinserted).
    const refsResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1',
      [secondSpecId]
    );
    expect(parseInt(refsResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  }, 60_000);
});

describe('POST /parse — .txt upload', () => {
  it('accepts .txt file and returns 202 with jobId', async () => {
    const fixture = readFileSync(resolve('tests/fixtures/text/numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'numbered-prefixes.txt');

    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { success: boolean; data: { jobId: string } };
    expect(body.success).toBe(true);
    expect(typeof body.data.jobId).toBe('string');

    const job = await waitForJob(body.data.jobId);
    expect(job.status).toBe('complete');
    const specId = job.result?.specId;
    if (specId) {
      await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
    }
  }, 30_000);

  it('parse job completes with nodeCount > 0 and capabilities read-only', async () => {
    const fixture = readFileSync(resolve('tests/fixtures/text/numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'test.txt');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    const postBody = (await postRes.json()) as { data: { jobId: string } };

    const job = await waitForJob(postBody.data.jobId);
    if (job.status === 'failed') throw new Error('Parse job failed');
    const specId = job.result?.specId;
    if (specId) cleanupIds.push(specId);

    expect(job.result).toBeDefined();
    expect(job.result?.nodeCount ?? 0).toBeGreaterThan(0);
    expect(job.result?.capabilities).toContain('read-only');
  }, 30_000);

  it('rejects .xyz file with 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['content'], { type: 'text/plain' }), 'bad.xyz');
    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});
