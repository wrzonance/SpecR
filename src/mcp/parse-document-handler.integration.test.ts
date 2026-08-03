// src/mcp/parse-document-handler.integration.test.ts
// #549 item 4: parse_document (like generate_docx) re-implements REST resolution instead of
// sharing it end-to-end — REST uploads run through a Piscina worker (lib/parse-worker.ts) while
// parse_document calls the same parser/index.ts orchestrator inline (#567). Schema parity alone
// (INV-4/INV-6) cannot catch a divergence living in a handler body rather than a tool contract —
// this asserts the two surfaces produce equivalent output for the SAME uploaded document.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from '../api/router.js';
import { errorHandler } from '../api/middleware/error.js';
import { pool } from '../db/index.js';
import type { ParseWarning } from '../ast/types.js';
import { handleParseDocument } from './parse-document-handler.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOCX_FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');

let server: Server;
let baseUrl: string;
const cleanupIds: string[] = [];

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);

  await new Promise<void>((resolveReady) => {
    server = app.listen(0, () => resolveReady());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  for (const id of cleanupIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  await new Promise<void>((resolveClose, reject) => {
    server.close((err) => (err != null ? reject(err) : resolveClose()));
  });
});

interface JobResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly capabilities?: string[];
  readonly warnings?: ParseWarning[];
}

interface JobData {
  readonly status: string;
  readonly result?: JobResult;
  readonly error?: string;
}

async function waitForJob(jobId: string, maxMs = 20_000): Promise<JobData> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/parse/jobs/${jobId}`);
    const body = (await res.json()) as { success: boolean; data: JobData };
    if (body.data.status === 'complete' || body.data.status === 'failed') return body.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`job ${jobId} did not complete within ${maxMs}ms`);
}

async function restParse(): Promise<JobResult> {
  const buf = readFileSync(DOCX_FIXTURE);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: DOCX_MIME }), 'csi-spec-sample.docx');
  const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  const body = (await res.json()) as { success: boolean; data?: { jobId: string } };
  if (res.status !== 202 || !body.data) throw new Error(`REST parse upload failed: ${res.status}`);
  const job = await waitForJob(body.data.jobId);
  if (job.status !== 'complete' || !job.result) {
    throw new Error(`REST parse job did not complete: ${job.error ?? '(no error)'}`);
  }
  return job.result;
}

interface McpParseResult {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly capabilities?: string[];
  readonly warnings?: ParseWarning[];
}

async function mcpParse(): Promise<McpParseResult> {
  const buf = readFileSync(DOCX_FIXTURE);
  const result = await handleParseDocument({
    filename: 'csi-spec-sample.docx',
    contentBase64: buf.toString('base64'),
  });
  if ('isError' in result && result.isError === true) {
    throw new Error(`MCP parse_document returned isError: ${result.content[0]?.text ?? ''}`);
  }
  const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
  return JSON.parse(text) as McpParseResult;
}

describe('parse_document <-> POST /parse behavioral parity (#549)', () => {
  // NOTE: parse_document's response may additionally carry `sectionInference` (section/title
  // provenance, enriched with a UFGS-corpus standardTitle/titleMatch) — openapi.yaml's
  // ParseJobResult never declares that property (processParseJob, src/api/parse.ts, never sets
  // it on the job result), so it is a deliberate MCP-only enrichment, not REST data this handler
  // silently drops. Every field ParseJobResult DOES document is asserted equal below.
  it('same DOCX upload -> equivalent section/title/nodeCount/warnings/capabilities', async () => {
    const rest = await restParse();
    cleanupIds.push(rest.specId);
    const mcp = await mcpParse();
    cleanupIds.push(mcp.specId);

    // specId is per-call (each surface persists its own spec row) — every OTHER field
    // ParseJobResult documents (openapi.yaml) must still agree, since both surfaces run
    // the same parser/index.ts orchestrator (#567) over the identical input bytes.
    expect(mcp.section).toBe(rest.section);
    expect(mcp.title).toBe(rest.title);
    expect(mcp.nodeCount).toBe(rest.nodeCount);
    expect(mcp.warnings).toEqual(rest.warnings);
    expect(mcp.capabilities).toEqual(rest.capabilities);
  });
});
