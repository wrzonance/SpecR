// src/api/generate-header-footer-parity.integration.test.ts
//
// #304 review finding (I8): REST's POST /specs/:id/generate
// (buildHeaderFooterOptions, src/api/generate-header-footer.ts) and MCP's
// generate_docx tool (resolveHeaderFooterInput, src/mcp/handlers.ts)
// independently re-implement the same header/footer resolution — documented
// in both files as a deliberate duplication across the api/↔mcp/ module
// boundary. The existing #304 suites (src/api/generate.integration.test.ts,
// src/mcp/server.integration.test.ts) each assert their own entry point in
// isolation against different specs/projects, so a hand-edit that desyncs
// the two duplicated implementations would pass both suites without ever
// being caught. This file drives BOTH entry points against the exact same
// specId/project/client DB state in one test and diffs the actual rendered
// bytes.

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLibrary,
  createSpec,
  insertTree,
  pool,
  upsertHeaderFooterConfig,
} from '../db/index.js';
import { registerMcpRoutes } from '../mcp/server.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

const TEST_PREFIX = 'hfparity-test-';

let server: Server;
let baseUrl: string;
let specId: string;
let projectId: string;
let clientLibraryId: string;
let companyLibraryId: string;

interface McpToolResponse {
  readonly result: {
    readonly isError?: boolean;
    readonly content: readonly { readonly type: string; readonly text: string }[];
  };
}

async function parseMcpResponse(res: Response): Promise<McpToolResponse> {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(dataLine?.slice(6) ?? '{}') as McpToolResponse;
  }
  return JSON.parse(text) as McpToolResponse;
}

async function mcpGenerateDocx(id: string): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'generate_docx', arguments: { specId: id } },
    }),
  });
  const parsed = await parseMcpResponse(res);
  if (parsed.result.isError === true) {
    throw new Error(`generate_docx tool returned isError: ${JSON.stringify(parsed.result)}`);
  }
  const firstContent = parsed.result.content[0];
  if (!firstContent) throw new Error('generate_docx tool returned no content');
  const data = JSON.parse(firstContent.text) as { contentBase64: string };
  return Buffer.from(data.contentBase64, 'base64');
}

async function restGenerateDocx(id: string): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/specs/${id}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.status !== 200) throw new Error(`REST generate failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function docxPart(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(name);
  if (!file) throw new Error(`${name} missing from generated DOCX`);
  return file.async('string');
}

async function insertProjectFixture(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${TEST_PREFIX}project`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test project');
  return row.id;
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

  const company = await createLibrary({ tier: 'company', name: `${TEST_PREFIX}company` });
  companyLibraryId = company.id;
  const client = await createLibrary({
    tier: 'client',
    name: `${TEST_PREFIX}client`,
    parentLibraryId: companyLibraryId,
  });
  clientLibraryId = client.id;

  specId = await createSpec({ section: '09 91 27', title: `${TEST_PREFIX}spec`, source: 'arcat' });
  await insertTree(
    {
      id: specId,
      section: '09 91 27',
      title: `${TEST_PREFIX}spec`,
      parts: [{ id: randomUUID(), type: 'part', text: 'GENERAL', children: [], meta: {} }],
    },
    specId,
    pool
  );

  projectId = await insertProjectFixture();
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, clientLibraryId]
  );
  await upsertHeaderFooterConfig(
    { projectId },
    {
      header: {
        left: { content: [{ kind: 'clientName' }] },
        right: { content: [{ kind: 'projectName' }] },
      },
      footer: {
        right: { content: [{ kind: 'pageNumber' }] },
        // #309 (ADR-071): a footer.table alongside the existing right-cell
        // paragraph, so this suite's REST/MCP parity coverage extends past
        // #304's paragraph-only fields to the table capability #309 adds.
        table: {
          rows: [
            {
              cells: [
                { content: [{ kind: 'literal', text: 'Rev.' }] },
                { content: [{ kind: 'sectionNumber' }] },
              ],
            },
          ],
        },
      },
    }
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.query(`DELETE FROM header_footer_configs WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM project_sources WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM project_specs WHERE project_id = $1`, [projectId]);
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [
    [clientLibraryId, companyLibraryId],
  ]);
});

// document.xml's body paragraphs are intentionally NOT compared here: REST's
// POST /specs/:id/generate always resolves a style template (falling back to
// the seeded UFGS-Default when the request omits templateId — see
// src/api/generate.ts's resolveStyleRules), while the MCP generate_docx tool
// never resolves one at all (no templateId in its inputSchema, src/mcp/tools.ts).
// That's a real REST/MCP divergence, but it's an unrelated, pre-existing gap
// in style-template resolution, not in #304's header/footer resolution —
// filed separately as issue #478 rather than smuggled into this fix. This
// test asserts the two things #304 actually governs: the sectPr
// header/footer wiring, and the rendered header/footer parts themselves.
function sectPrFragment(documentXml: string): string {
  const match = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(documentXml);
  if (!match) throw new Error('w:sectPr missing from document.xml');
  return match[0];
}

describe('REST/MCP header-footer parity (#304 I8)', () => {
  it('renders byte-identical sectPr header/footer wiring, header1.xml, and footer1.xml for the same specId + DB state', async () => {
    const restBuf = await restGenerateDocx(specId);
    const mcpBuf = await mcpGenerateDocx(specId);

    const restDocument = await docxPart(restBuf, 'word/document.xml');
    const mcpDocument = await docxPart(mcpBuf, 'word/document.xml');
    expect(sectPrFragment(mcpDocument)).toBe(sectPrFragment(restDocument));

    const restHeader = await docxPart(restBuf, 'word/header1.xml');
    const mcpHeader = await docxPart(mcpBuf, 'word/header1.xml');
    expect(mcpHeader).toBe(restHeader);
    expect(restHeader).toContain(`${TEST_PREFIX}client`);
    expect(restHeader).toContain(`${TEST_PREFIX}project`);

    const restFooter = await docxPart(restBuf, 'word/footer1.xml');
    const mcpFooter = await docxPart(mcpBuf, 'word/footer1.xml');
    expect(mcpFooter).toBe(restFooter);

    // #309 (ADR-071): the footer.table configured in beforeAll must reach
    // both entry points identically — a real <w:tbl>, carrying both the
    // literal cell and the resolved sectionNumber field cell, not just an
    // empty/paragraph-only footer part.
    expect(restFooter).toContain('<w:tbl>');
    expect(restFooter).toContain('Rev.');
    expect(restFooter).toContain('09 91 27');
  });
});
