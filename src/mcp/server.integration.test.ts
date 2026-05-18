// src/mcp/server.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { pool, createSpec, insertTree } from '../db/index.js';
import { registerMcpRoutes } from './server.js';

let server: Server;
let baseUrl: string;
let mcpSpecId: string;
let parsedSpecId: string | null = null;

async function mcpCall(
  url: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  // StreamableHTTP may return SSE (text/event-stream) or plain JSON.
  // For stateless single-request calls it typically returns JSON directly.
  // If we get SSE, parse out the first data: line.
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine) return JSON.parse(dataLine.slice(6)) as unknown;
    return {};
  }
  return JSON.parse(text) as unknown;
}

beforeAll(async () => {
  const app = express();
  // Skip global JSON parsing for /mcp — route applies its own 15mb-limit parser
  const restJson = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/mcp')) return next();
    restJson(req, res, next);
  });
  registerMcpRoutes(app);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3001;
  baseUrl = `http://localhost:${port}`;

  // Use a section that exists in spec_sections for list_sections test to work.
  // Query spec_sections to find a valid division-27 section, then create spec with that section.
  const sectionRow = await pool.query<{ section_number: string }>(
    `SELECT section_number FROM spec_sections WHERE division = '27' LIMIT 1`
  );
  const testSection = sectionRow.rows[0]?.section_number ?? '27 10 00';

  mcpSpecId = await createSpec({ section: testSection, title: 'MCP Test Spec', source: 'arcat' });
  await insertTree(
    {
      id: mcpSpecId,
      section: testSection,
      title: 'MCP Test Spec',
      parts: [
        {
          id: '30000000-0000-4000-8000-000000000001',
          type: 'part',
          text: 'GENERAL',
          children: [
            {
              id: '30000000-0000-4000-8000-000000000002',
              type: 'article',
              text: 'SCOPE',
              children: [
                {
                  id: '30000000-0000-4000-8000-000000000003',
                  type: 'pr1',
                  text: 'Provide fiber optic backbone cabling.',
                  children: [],
                  meta: {},
                },
              ],
              meta: {},
            },
          ],
          meta: {},
        },
      ],
    },
    mcpSpecId,
    pool
  );

  // Store for tests
  (global as Record<string, unknown>)['mcpTestSection'] = testSection;
});

afterAll(async () => {
  if (parsedSpecId) {
    await pool.query('DELETE FROM specs WHERE id = $1', [parsedSpecId]);
  }
  await pool.query('DELETE FROM specs WHERE id = $1', [mcpSpecId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /mcp — initialize', () => {
  it('responds to initialize request', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    });
    const b = body as Record<string, unknown>;
    expect(b['jsonrpc']).toBe('2.0');
    const result = b['result'] as Record<string, unknown>;
    expect(result['serverInfo']).toBeDefined();
  });
});

describe('tool: search_library', () => {
  it('finds paragraphs by text', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'search_library',
      arguments: { query: 'fiber optic backbone' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    expect(content[0]!.type).toBe('text');
    const results = JSON.parse(content[0]!.text) as unknown[];
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns empty for no match', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'search_library',
      arguments: { query: 'xyznonexistent99999' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const results = JSON.parse(content[0]!.text) as unknown[];
    expect(results).toEqual([]);
  });
});

describe('tool: get_spec', () => {
  it('returns tree with parts', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: mcpSpecId },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
    const tree = data['tree'] as Record<string, unknown>;
    expect(tree['id']).toBe(mcpSpecId);
    expect(Array.isArray(tree['parts'])).toBe(true);
  });

  it('returns isError for unknown id', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

describe('tool: list_sections', () => {
  it('returns sections with inDatabase flag for loaded spec', async () => {
    const testSection = (global as Record<string, unknown>)['mcpTestSection'] as string;
    const division = testSection.slice(0, 2);
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'list_sections',
      arguments: { division },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const sections = JSON.parse(content[0]!.text) as { section: string; inDatabase: boolean }[];
    const loaded = sections.find((s) => s.section === testSection);
    expect(loaded).toBeDefined();
    expect(loaded!.inDatabase).toBe(true);
  });
});

describe('resource: specr://specs/{id}', () => {
  it('returns spec as markdown', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'resources/read', {
      uri: `specr://specs/${mcpSpecId}`,
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    expect(contents[0]!.mimeType).toBe('text/markdown');
    expect(contents[0]!.text).toContain('## PART 1 - GENERAL');
  });
});

describe('resource: specr://sections', () => {
  it('returns section index as markdown table', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'resources/read', {
      uri: 'specr://sections',
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    expect(contents[0]!.mimeType).toBe('text/markdown');
    expect(contents[0]!.text).toContain('| Section |');
  });
});

describe('tool: get_paragraph', () => {
  it('returns node and ancestor chain for known paragraph', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '30000000-0000-4000-8000-000000000003' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      node: { id: string; nodeType: string; text: string };
      ancestors: { id: string; nodeType: string }[];
    };
    expect(data.node.id).toBe('30000000-0000-4000-8000-000000000003');
    expect(data.node.nodeType).toBe('pr1');
    expect(data.node.text).toBe('Provide fiber optic backbone cabling.');
    expect(data.ancestors).toHaveLength(2);
    expect(data.ancestors[0]!.id).toBe('30000000-0000-4000-8000-000000000001');
    expect(data.ancestors[1]!.id).toBe('30000000-0000-4000-8000-000000000002');
    expect(data.ancestors[0]!.nodeType).toBe('part');
    expect(data.ancestors[1]!.nodeType).toBe('article');
  });

  it('returns isError for unknown UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

describe('tool: parse_document', () => {
  it('parses a valid base64-encoded SEC file and returns spec summary', async () => {
    // Inline minimal SEC — section 99 99 99 is not in the seed corpus, so no
    // conflict with parallel tests that operate on seeded UFGS specs.
    const minimalSec =
      '<SEC><SCN>99 99 99</SCN><STL>MCP Test Section</STL>' +
      '<PRT><TTL>PART 1 - GENERAL</TTL>' +
      '<SPT><TTL>SUMMARY</TTL><TXT>Test paragraph content.</TXT></SPT>' +
      '</PRT></SEC>';
    const secBase64 = Buffer.from(minimalSec, 'utf-8').toString('base64');

    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: 'test.sec', contentBase64: secBase64 },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    expect(result['isError'], content[0]?.text).not.toBe(true);
    const data = JSON.parse(content[0]!.text) as {
      specId: string;
      section: string;
      title: string;
      nodeCount: number;
    };
    expect(typeof data.specId).toBe('string');
    expect(data.nodeCount).toBeGreaterThan(0);
    parsedSpecId = data.specId;
  });

  it('returns isError for invalid base64', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: 'test.sec', contentBase64: '!!!not-base64!!!' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });

  it('returns isError for unsupported file extension', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: { filename: 'file.pdf', contentBase64: Buffer.from('hello').toString('base64') },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

describe('tool: generate_docx', () => {
  it('returns base64 DOCX for a valid spec', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'generate_docx',
      arguments: { specId: mcpSpecId },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      specId: string;
      section: string;
      title: string;
      sizeBytes: number;
      contentBase64: string;
    };
    expect(data.specId).toBe(mcpSpecId);
    expect(data.sizeBytes).toBeGreaterThan(0);
    expect(typeof data.contentBase64).toBe('string');
    expect(data.contentBase64.length).toBeGreaterThan(0);
  });

  it('returns isError for unknown spec UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'generate_docx',
      arguments: { specId: '00000000-0000-4000-8000-000000000000' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });
});

describe('GET /mcp', () => {
  it('returns 405 in stateless mode', async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });
});

describe('load_files tool', () => {
  it('returns LoadResult JSON for a valid glob', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {
        glob: 'docs/references/UFGS/DIVISION_27/*.SEC',
        dry_run: true,
      },
    });

    const rpc = response as { result?: { content?: { text?: string }[] } };
    const text = rpc.result?.content?.[0]?.text;
    expect(text).toBeDefined();
    const loadResult = JSON.parse(text ?? '{}') as {
      total: number;
      succeeded: number;
      failed: number;
      errors: unknown[];
    };
    expect(typeof loadResult.total).toBe('number');
    expect(typeof loadResult.succeeded).toBe('number');
    expect(typeof loadResult.failed).toBe('number');
    expect(Array.isArray(loadResult.errors)).toBe(true);
    expect(loadResult.total).toBeGreaterThan(0);
  });

  it('returns zero-result for non-matching glob — not an error', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {
        glob: 'docs/references/UFGS/**/*.NOMATCH',
      },
    });

    const rpc = response as { result?: { content?: { text?: string }[] } };
    const text = rpc.result?.content?.[0]?.text;
    const loadResult = JSON.parse(text ?? '{}') as { total: number };
    expect(loadResult.total).toBe(0);
  });

  it('returns error when neither glob nor paths provided', async () => {
    const url = `${baseUrl}/mcp`;
    const response = await mcpCall(url, 'tools/call', {
      name: 'load_files',
      arguments: {},
    });

    const rpc = response as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(rpc.result?.isError).toBe(true);
  });
});
