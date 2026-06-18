import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSpec, insertTree, pool } from '../db/index.js';
import type { DiffResult } from '../merge/index.js';
import { registerMcpRoutes } from '../mcp/server.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ORIGINAL_TEXT = 'Install listed copper cabling.';
const REVISED_TEXT = 'Install revised copper cabling.';

let server: Server;
let baseUrl: string;
let specId: string;
let partId: string;
let articleId: string;
let paragraphId: string;

interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

async function mcpCall(
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const line = text.split('\n').find((entry) => entry.startsWith('data: '));
    return JSON.parse(line?.slice(6) ?? '{}') as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function fetchGeneratedDocx(): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, { method: 'POST' });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function postDiff(
  buffer: Buffer,
  filename = 'returned.docx'
): Promise<{
  readonly status: number;
  readonly body: ApiResponse<DiffResult>;
}> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), filename);
  const res = await fetch(`${baseUrl}/specs/${specId}/diff`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as ApiResponse<DiffResult> };
}

async function updateDocumentXml(buffer: Buffer, edit: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  zip.file('word/document.xml', edit(await file.async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function replaceParagraphText(xml: string): string {
  if (!xml.includes(ORIGINAL_TEXT)) throw new Error('expected paragraph text missing');
  return xml.replace(ORIGINAL_TEXT, REVISED_TEXT);
}

function removeContentControl(xml: string): string {
  const tagIndex = xml.indexOf(`specr-uuid-${paragraphId}`);
  if (tagIndex === -1) throw new Error('expected content-control tag missing');
  const start = xml.lastIndexOf('<w:sdt>', tagIndex);
  const end = xml.indexOf('</w:sdt>', tagIndex);
  if (start === -1 || end === -1) throw new Error('content control bounds missing');
  return xml.slice(0, start) + xml.slice(end + '</w:sdt>'.length);
}

beforeAll(async () => {
  const app = express();
  const restJson = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/mcp')) return next();
    restJson(req, res, next);
  });
  app.use(router);
  registerMcpRoutes(app, { rateLimitMax: 1000 });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  partId = randomUUID();
  articleId = randomUUID();
  paragraphId = randomUUID();
  specId = await createSpec({
    section: '27 15 00',
    title: 'Diff Integration Spec',
    source: `d35_${randomUUID().slice(0, 8)}`,
  });
  await insertTree(
    {
      id: specId,
      section: '27 15 00',
      title: 'Diff Integration Spec',
      parts: [
        {
          id: partId,
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: articleId,
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                {
                  id: paragraphId,
                  type: 'pr1',
                  text: ORIGINAL_TEXT,
                  meta: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /specs/:id/diff (integration)', () => {
  it('unmodified generated DOCX returns no added, modified, deleted, or conflicts', async () => {
    const { status, body } = await postDiff(await fetchGeneratedDocx());

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      warnings: [],
    });
  });

  it('changed paragraph text returns modified diff with uuid, base, theirs, and ours', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), replaceParagraphText);
    const { status, body } = await postDiff(edited);

    expect(status).toBe(200);
    expect(body.data?.modified).toEqual([
      { uuid: paragraphId, base: ORIGINAL_TEXT, theirs: REVISED_TEXT, ours: ORIGINAL_TEXT },
    ]);
    expect(body.data?.deleted).toEqual([]);
    expect(body.data?.conflicts).toEqual([]);
  });

  it('deleted content-control paragraph returns deleted UUID', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), removeContentControl);
    const { status, body } = await postDiff(edited);

    expect(status).toBe(200);
    expect(body.data?.deleted).toEqual([paragraphId]);
    expect(body.data?.modified).toEqual([]);
  });

  it('non-DOCX uploads return 422', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a docx'], { type: 'text/plain' }), 'bad.txt');
    const res = await fetch(`${baseUrl}/specs/${specId}/diff`, { method: 'POST', body: form });
    const body = (await res.json()) as ApiResponse<never>;

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toContain('DOCX');
  });
});

describe('tool: get_spec_diff', () => {
  it('returns the same DiffResult shape as REST for an edited DOCX', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), replaceParagraphText);
    const rest = await postDiff(edited);
    const rpc = await mcpCall('tools/call', {
      name: 'get_spec_diff',
      arguments: { specId, contentBase64: edited.toString('base64') },
    });
    const result = rpc['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const mcp = JSON.parse(content[0]?.text ?? '{}') as DiffResult;

    expect(result['isError']).toBeUndefined();
    expect(mcp).toEqual(rest.body.data);
  });
});

describe('resource: specr://specs/{id}/diff', () => {
  it('returns JSON DiffResult for the generated current DOCX', async () => {
    const rpc = await mcpCall('resources/read', { uri: `specr://specs/${specId}/diff` });
    const result = rpc['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    const diff = JSON.parse(contents[0]?.text ?? '{}') as DiffResult;

    expect(contents[0]?.mimeType).toBe('application/json');
    expect(diff).toEqual({ added: [], modified: [], deleted: [], conflicts: [], warnings: [] });
  });
});
