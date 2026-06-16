import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import type { DiffResult } from '../merge/index.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const EDIT_SUFFIX = ' Round-trip acceptance edit.';

let server: Server;
let baseUrl: string;
const cleanupIds: string[] = [];

interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

interface JobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
}

interface JobData {
  readonly status: string;
  readonly result?: JobResult;
  readonly error?: string;
}

interface MergeResult {
  readonly applied: number;
  readonly rejected: number;
}

interface MergeTarget {
  readonly id: string;
  readonly text: string;
}

interface SpecNodeResponse {
  readonly id: string;
  readonly text: string;
  readonly children: readonly SpecNodeResponse[];
}

interface SpecTreeResponse {
  readonly parts: readonly SpecNodeResponse[];
}

async function waitForJob(jobId: string): Promise<JobData> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/parse/jobs/${jobId}`);
    const body = (await res.json()) as ApiResponse<JobData>;
    const job = body.data;
    if (job?.status === 'complete' || job?.status === 'failed') return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`job ${jobId} did not complete`);
}

async function parseFixture(): Promise<string> {
  const fixture = readFileSync(resolve('tests/fixtures/sec/27_41_00.SEC'));
  const form = new FormData();
  form.append('file', new Blob([fixture], { type: 'text/plain' }), '27_41_00.sec');
  const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  expect(res.status).toBe(202);
  const body = (await res.json()) as ApiResponse<{ readonly jobId: string }>;
  const jobId = body.data?.jobId;
  if (!jobId) throw new Error('parse response did not return jobId');
  const job = await waitForJob(jobId);
  if (job.status === 'failed') throw new Error(job.error ?? 'parse job failed');
  const specId = job.result?.specId;
  if (!specId) throw new Error('parse job did not return specId');
  cleanupIds.push(specId);
  return specId;
}

async function findMergeTarget(specId: string): Promise<MergeTarget> {
  const result = await pool.query<MergeTarget>(
    `SELECT id, text
     FROM paragraphs
     WHERE spec_id = $1
       AND node_type IN ('pr1', 'pr2', 'pr3', 'continuation')
       AND length(text) BETWEEN 20 AND 120
       AND text !~ '[<>&]'
     ORDER BY length(text), text
     LIMIT 1`,
    [specId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('no deterministic paragraph target found');
  return row;
}

async function fetchGeneratedDocx(specId: string): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, { method: 'POST' });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function updateDocumentXml(buffer: Buffer, edit: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  zip.file('word/document.xml', edit(await file.async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function contentControlBlock(
  xml: string,
  uuid: string
): { readonly start: number; readonly end: number } {
  const tagIndex = xml.indexOf(`specr-uuid-${uuid}`);
  if (tagIndex === -1) throw new Error(`content control tag missing for ${uuid}`);
  const start = xml.lastIndexOf('<w:sdt>', tagIndex);
  const close = xml.indexOf('</w:sdt>', tagIndex);
  if (start === -1 || close === -1) throw new Error('content control bounds missing');
  return { start, end: close + '</w:sdt>'.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mutateTargetText(xml: string, target: MergeTarget): string {
  const bounds = contentControlBlock(xml, target.id);
  const block = xml.slice(bounds.start, bounds.end);
  const textNode = new RegExp(`<w:t([^>]*)>${escapeRegExp(target.text)}</w:t>`);
  if (!textNode.test(block)) throw new Error('target text node missing from content control');
  const replacement = `<w:t$1>${target.text}${EDIT_SUFFIX}</w:t>`;
  return xml.slice(0, bounds.start) + block.replace(textNode, replacement) + xml.slice(bounds.end);
}

async function postDiff(
  specId: string,
  buffer: Buffer
): Promise<{ readonly status: number; readonly body: ApiResponse<DiffResult> }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), 'edited.docx');
  const res = await fetch(`${baseUrl}/specs/${specId}/diff`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as ApiResponse<DiffResult> };
}

async function postMerge(
  specId: string,
  diff: DiffResult,
  acceptedId: string
): Promise<{ readonly status: number; readonly body: ApiResponse<MergeResult> }> {
  const res = await fetch(`${baseUrl}/specs/${specId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accept: [acceptedId], diff }),
  });
  return { status: res.status, body: (await res.json()) as ApiResponse<MergeResult> };
}

function findNode(nodes: readonly SpecNodeResponse[], id: string): SpecNodeResponse | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function fetchSpec(specId: string): Promise<SpecTreeResponse> {
  const res = await fetch(`${baseUrl}/specs/${specId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as ApiResponse<SpecTreeResponse>;
  if (!body.data) throw new Error('GET /specs/:id returned no data');
  return body.data;
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  const restJson = express.json();
  app.use((req, res, next) => {
    if (req.path === '/parse' || req.path.endsWith('/diff')) return next();
    restJson(req, res, next);
  });
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolveServer) => {
    server = app.listen(0, () => resolveServer());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  }
  await new Promise<void>((resolveServer, reject) => {
    server.close((err) => (err != null ? reject(err) : resolveServer()));
  });
});

describe('Phase 3 DOCX round trip (integration)', () => {
  it('parses SEC, generates DOCX, preserves content-control UUID, diffs, merges, and reads back accepted text', async () => {
    // KNOWN AMBIGUITY: Real editors may strip or rewrite w:sdt/w:tag anchors;
    // CI validates only the preserved-anchor path.
    // Phase 3 assumes ordinary Microsoft Word and LibreOffice text edits preserve
    // the surrounding w:sdt/w:tag anchors. This deterministic CI edit mutates only
    // one w:t node and leaves those content controls intact.
    const specId = await parseFixture();
    const target = await findMergeTarget(specId);
    const edited = await updateDocumentXml(await fetchGeneratedDocx(specId), (xml) =>
      mutateTargetText(xml, target)
    );

    const { status: diffStatus, body: diffBody } = await postDiff(specId, edited);
    expect(diffStatus).toBe(200);
    const diff = diffBody.data;
    if (!diff) throw new Error('diff response missing data');
    expect(diff.modified).toEqual([
      {
        uuid: target.id,
        base: target.text,
        theirs: `${target.text}${EDIT_SUFFIX}`,
        ours: target.text,
      },
    ]);

    const { status: mergeStatus, body: mergeBody } = await postMerge(specId, diff, target.id);
    expect(mergeStatus).toBe(200);
    expect(mergeBody.data).toEqual({ applied: 1, rejected: 0 });

    const tree = await fetchSpec(specId);
    const node = findNode(tree.parts, target.id);
    expect(node?.text).toBe(`${target.text}${EDIT_SUFFIX}`);
  }, 30_000);
});
