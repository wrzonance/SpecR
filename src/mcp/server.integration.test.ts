// src/mcp/server.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { pool, createSpec, insertTree } from '../db/index.js';
import { registerMcpRoutes } from './server.js';

let server: Server;
let baseUrl: string;
let mcpSpecId: string;
let mcpProjectId: string;
let mcpProjectName: string;
let mcpTargetSpecId: string;
let mcpTargetSection: string;
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
  // This suite intentionally makes >20 MCP calls — raise the rate limit to avoid 429s.
  registerMcpRoutes(app, { rateLimitMax: 1000 });

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
              meta: {
                conflicts: [{ signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' }],
              },
            },
          ],
          meta: {},
        },
      ],
    },
    mcpSpecId,
    pool
  );

  const refSuffix = randomUUID().slice(0, 8);
  mcpTargetSection = '09 91 00';
  mcpTargetSpecId = await createSpec({
    section: mcpTargetSection,
    title: 'MCP Reference Target',
    source: `mcp162_${refSuffix}`,
  });
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`MCP Reference Project ${refSuffix}`]
  );
  const projectId = project.rows[0]?.id;
  if (projectId === undefined) throw new Error('failed to insert MCP reference project');
  mcpProjectId = projectId;
  mcpProjectName = `MCP Reference Project ${refSuffix}`;
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1), ($1, $3, 2)`,
    [mcpProjectId, mcpSpecId, mcpTargetSpecId]
  );
  await pool.query(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section,
        target_spec_id, reference_text)
     VALUES ($1, '30000000-0000-4000-8000-000000000003', 'section', $2, $3, $4)`,
    [mcpSpecId, mcpTargetSection, mcpTargetSpecId, 'MCP source cites painting']
  );

  // Store for tests
  (global as Record<string, unknown>)['mcpTestSection'] = testSection;
});

afterAll(async () => {
  await pool.query('DELETE FROM projects WHERE id = $1', [mcpProjectId]);
  await pool.query('DELETE FROM specs WHERE id = $1', [mcpTargetSpecId]);
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

  it('surfaces styleSource: null when no template is assigned (#138)', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: mcpSpecId },
    });
    const result = (body as Record<string, unknown>)['result'] as Record<string, unknown>;
    const content = result['content'] as { text: string }[];
    const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(data['styleSource']).toBeNull();
  });

  it('surfaces styleSource { templateId, templateName } when assigned (#138)', async () => {
    const tmplName = `mcp-style-source-${randomUUID().slice(0, 8)}`;
    const tmpl = await pool.query<{ id: string }>(
      `INSERT INTO style_templates (name) VALUES ($1) RETURNING id`,
      [tmplName]
    );
    const templateId = tmpl.rows[0]?.id;
    if (templateId === undefined) throw new Error('failed to insert style template');

    try {
      await pool.query(`UPDATE specs SET style_template_id = $2 WHERE id = $1`, [
        mcpSpecId,
        templateId,
      ]);
      const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
        name: 'get_spec',
        arguments: { specId: mcpSpecId },
      });
      const result = (body as Record<string, unknown>)['result'] as Record<string, unknown>;
      const content = result['content'] as { text: string }[];
      const data = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(data['styleSource']).toEqual({ templateId, templateName: tmplName });
    } finally {
      // Clear the reference (RESTRICT) before dropping the template.
      await pool.query(`UPDATE specs SET style_template_id = NULL WHERE id = $1`, [mcpSpecId]);
      await pool.query(`DELETE FROM style_templates WHERE id = $1`, [templateId]);
    }
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

describe('tool: list_projects', () => {
  it('returns project ids and names', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'list_projects',
      arguments: {},
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const projects = JSON.parse(content[0]!.text) as { id: string; name: string }[];
    expect(projects).toEqual(expect.arrayContaining([{ id: mcpProjectId, name: mcpProjectName }]));
  });
});

describe('tool: get_references', () => {
  it('returns project-scoped outbound and inbound arrays', async () => {
    const testSection = (global as Record<string, unknown>)['mcpTestSection'] as string;
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_references',
      arguments: { projectId: mcpProjectId, section: testSection },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      projectId: string;
      section: string;
      outbound: { targetSection: string | null }[];
      inbound: unknown[];
    };
    expect(data.projectId).toBe(mcpProjectId);
    expect(data.section).toBe(testSection);
    expect(data.outbound).toEqual([expect.objectContaining({ targetSection: mcpTargetSection })]);
    expect(data.inbound).toEqual([]);
  });

  it('direction=to narrows to inbound references', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_references',
      arguments: { projectId: mcpProjectId, section: mcpTargetSection, direction: 'to' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      outbound: unknown[];
      inbound: { sourceSpecId: string }[];
    };
    expect(data.outbound).toEqual([]);
    expect(data.inbound).toEqual([expect.objectContaining({ sourceSpecId: mcpSpecId })]);
  });

  it('returns isError for malformed section', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_references',
      arguments: { projectId: mcpProjectId, section: '9 91 00' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
  });

  it('returns isError for unknown project', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_references',
      arguments: { projectId: '00000000-0000-0000-0000-000000000000', section: mcpTargetSection },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    expect(result['isError']).toBe(true);
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

describe('tool: get_paragraph — conflicts (#56)', () => {
  it('includes conflicts on a conflicted node', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '30000000-0000-4000-8000-000000000002' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      node: { id: string; conflicts?: unknown };
    };
    expect(data.node.conflicts).toEqual([{ signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' }]);
  });

  it('omits conflicts key for a clean node and its clean ancestors', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_paragraph',
      arguments: { paragraphId: '30000000-0000-4000-8000-000000000003' },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      node: Record<string, unknown>;
      ancestors: Record<string, unknown>[];
    };
    expect(Object.keys(data.node)).not.toContain('conflicts');
    // ancestor ...0002 IS conflicted — it must carry the field
    expect(data.ancestors[1]!['conflicts']).toEqual([
      { signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' },
    ]);
    // ancestor ...0001 (part) is clean — field absent
    expect(Object.keys(data.ancestors[0]!)).not.toContain('conflicts');
  });
});

describe('tool: get_spec — conflicts (#56)', () => {
  it('exposes meta.conflicts on tree nodes', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec',
      arguments: { specId: mcpSpecId },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const data = JSON.parse(content[0]!.text) as {
      tree: {
        parts: { meta: Record<string, unknown>; children: { meta: Record<string, unknown> }[] }[];
      };
    };
    const article = data.tree.parts[0]!.children[0]!;
    expect(article.meta['conflicts']).toEqual([
      { signal: 2, reportedIlvl: 2, reportedNodeType: 'pr1' },
    ]);
    expect(Object.keys(data.tree.parts[0]!.meta)).not.toContain('conflicts');
  });
});

describe('tool: parse_document', () => {
  // Inline minimal SEC — section 99 99 99 is not in the seed corpus, so no
  // conflict with parallel tests that operate on seeded UFGS specs.
  const minimalSec =
    '<SEC><SCN>99 99 99</SCN><STL>MCP Test Section</STL>' +
    '<PRT><TTL>PART 1 - GENERAL</TTL>' +
    '<SPT><TTL>SUMMARY</TTL><TXT>Test paragraph content.</TXT></SPT>' +
    '</PRT></SEC>';

  it('parses a valid base64-encoded SEC file and returns spec summary', async () => {
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

  it('records origin_meta provenance for the ingested file (#93)', async () => {
    const r = await pool.query<{
      origin_meta: { filename: string; sha256: string; loader: string } | null;
    }>('SELECT origin_meta FROM specs WHERE id = $1', [parsedSpecId]);
    expect(r.rows[0]?.origin_meta).toEqual({
      filename: 'test.sec',
      sha256: createHash('sha256').update(Buffer.from(minimalSec, 'utf-8')).digest('hex'),
      loader: 'mcp:parse_document',
    });
  });

  it('sanitizes path fragments from the caller-supplied filename — C:\\fakepath\\windows.sec → windows.sec', async () => {
    // Distinct section (99 99 98) so the upsert does not collide with the spec
    // created by the provenance test above.
    const winSec = minimalSec.replace('99 99 99', '99 99 98');
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'parse_document',
      arguments: {
        filename: 'C:\\fakepath\\windows.sec',
        contentBase64: Buffer.from(winSec, 'utf-8').toString('base64'),
      },
    });
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    expect(result['isError'], content[0]?.text).not.toBe(true);
    const data = JSON.parse(content[0]!.text) as { specId: string };
    const r = await pool.query<{ origin_meta: { filename: string } | null }>(
      'SELECT origin_meta FROM specs WHERE id = $1',
      [data.specId]
    );
    expect(r.rows[0]?.origin_meta?.filename).toBe('windows.sec');
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

describe('stateful sessions (#45)', () => {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  // initialize WITHOUT a session header mints a stateful session; the server
  // returns the new id in the mcp-session-id response header.
  async function openSession(): Promise<{ sessionId: string }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'session-test', version: '1.0' },
        },
      }),
    });
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId, 'initialize must mint a session id').toBeTruthy();
    return { sessionId: sessionId as string };
  }

  it('routes a follow-up request with the same mcp-session-id to the same server', async () => {
    const { sessionId } = await openSession();
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    // A stateful, initialized session echoes its id and serves the request (not a 400).
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBe(sessionId);
  });

  it('DELETE with a live session id returns 204 and terminates it', async () => {
    const { sessionId } = await openSession();
    const del = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
    expect(del.status).toBe(204);
    // After deletion the session id no longer maps to a transport — a follow-up
    // is treated as an unknown session and rejected by the SDK (404).
    const after = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    });
    expect(after.status).toBe(404);
  });

  it('DELETE without a session header returns 400', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('DELETE with an unknown session id returns 404', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status).toBe(404);
  });

  it('stateless client (no session id) gets no session header — fresh instance per request', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});

describe('tool: get_spec_lineage (#97)', () => {
  let lineageProjectId: string;
  let lineageCloneId: string;

  beforeAll(async () => {
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Lineage Project (mcp #97)') RETURNING id`
    );
    const projId = proj.rows[0]?.id;
    if (!projId) throw new Error('beforeAll: failed to insert lineage project');
    lineageProjectId = projId;
    // Clone mcpSpecId — snapshot content_version at clone time so behindBy = 0
    const clone = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id, parent_spec_id,
                          origin_version, content_version)
       SELECT s.section, s.title, s.source, $1, s.id, s.content_version, 1
       FROM specs s WHERE s.id = $2 RETURNING id`,
      [lineageProjectId, mcpSpecId]
    );
    const cloneId = clone.rows[0]?.id;
    if (!cloneId) throw new Error('beforeAll: failed to insert lineage clone');
    lineageCloneId = cloneId;
  });

  afterAll(async () => {
    // Delete clone first — parent FK constraint requires child deleted before parent
    await pool.query('DELETE FROM specs WHERE id = $1', [lineageCloneId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [lineageProjectId]);
    // mcpSpecId (root parent) is deleted by the file-level afterAll which runs after all describe-level afterAlls
  });

  it('returns the custody chain via tools/call', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec_lineage',
      arguments: { specId: lineageCloneId },
    });
    const b = body as {
      result: { isError?: boolean; content: { type: string; text: string }[] };
    };
    expect(b.result.isError).toBeUndefined();
    const payload = JSON.parse(b.result.content[0]?.text ?? '{}') as {
      chain: { specId: string; scope: string; behindBy: number | null }[];
      originMeta: unknown;
    };
    expect(payload.chain).toHaveLength(2);
    expect(payload.chain[0]?.specId).toBe(lineageCloneId);
    expect(payload.chain[0]?.scope).toBe('project');
    // behindBy = parent.content_version - clone.origin_version; clone snapshotted
    // parent's content_version at beforeAll time, and no test in this suite mutates
    // mcpSpecId content — so this is deterministically 0.
    expect(payload.chain[0]?.behindBy).toBe(0);
    expect(payload.chain[1]?.specId).toBe(mcpSpecId);
    expect(payload.chain[1]?.scope).toBe('library');
    expect(payload.chain[1]?.behindBy).toBeNull();
  });

  it('returns isError for unknown UUID', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/call', {
      name: 'get_spec_lineage',
      arguments: { specId: '00000000-0000-0000-0000-000000000000' },
    });
    const b = body as { result: { isError?: boolean } };
    expect(b.result.isError).toBe(true);
  });
});

describe('capability gating (#43)', () => {
  it('exposes read+write tools but no destructive tool under the default read,write posture', async () => {
    const body = await mcpCall(`${baseUrl}/mcp`, 'tools/list', {});
    const b = body as Record<string, unknown>;
    const result = b['result'] as Record<string, unknown>;
    const tools = result['tools'] as {
      name: string;
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }[];
    const names = tools.map((t) => t.name);
    // A known read tool and a known write tool are exposed under the default posture…
    expect(names).toContain('get_spec');
    expect(names).toContain('parse_document');
    // A wave-3 write tool is exposed…
    expect(names).toContain('update_paragraph');
    // …but no destructive tool leaks (guards future waves from exposing one by default).
    expect(tools.some((t) => t.annotations?.destructiveHint === true)).toBe(false);
    // delete_project and delete_association (destructive) exist but are gated off by the
    // default read,write posture.
    expect(names).not.toContain('delete_project');
    expect(names).not.toContain('delete_association');
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
