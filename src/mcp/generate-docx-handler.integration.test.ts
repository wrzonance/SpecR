// src/mcp/generate-docx-handler.integration.test.ts
// #567: generate_docx now reuses REST's style-rule and section-number-format
// resolution (resolveStyleRulesForMcp / resolveSpecGenerationContext), so its
// output must be byte-identical to POST /specs/:id/generate for the same
// request. word/document.xml + word/numbering.xml only — docProps/core.xml
// carries a per-call generation timestamp, so it's never fetched at all here
// (same sidestep as src/api/generate.integration.test.ts's fetchDocParts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from '../api/router.js';
import { errorHandler } from '../api/middleware/error.js';
import { pool, createTemplateWithRules, deleteTemplate } from '../db/index.js';
import { handleGenerateDocx } from './generate-docx-handler.js';

let server: Server;
let baseUrl: string;
let testSpecId: string;

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

  const specRes = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    ['27 14 23', 'MCP Generate Parity Test', 'ufgs']
  );
  const specRow = specRes.rows[0];
  if (!specRow) throw new Error('failed to insert test spec');
  testSpecId = specRow.id;

  const partRes = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, NULL, 'part', 'GENERAL', 1, false) RETURNING id`,
    [testSpecId]
  );
  const partRow = partRes.rows[0];
  if (!partRow) throw new Error('failed to insert test part');

  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, $2, 'article', 'REFERENCES', 1, false)`,
    [testSpecId, partRow.id]
  );
});

afterAll(async () => {
  if (testSpecId) {
    await pool.query('DELETE FROM specs WHERE id = $1', [testSpecId]);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

interface DocParts {
  readonly documentXml: string;
  readonly numberingXml: string;
}

async function docPartsFromZipBuffer(buf: Buffer): Promise<DocParts> {
  const zip = await JSZip.loadAsync(buf);
  const documentFile = zip.file('word/document.xml');
  const numberingFile = zip.file('word/numbering.xml');
  if (!documentFile) throw new Error('document.xml missing');
  if (!numberingFile) throw new Error('numbering.xml missing');
  return {
    documentXml: await documentFile.async('string'),
    numberingXml: await numberingFile.async('string'),
  };
}

async function restDocParts(body: Record<string, unknown>): Promise<DocParts> {
  const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`REST generate failed: ${res.status}`);
  return docPartsFromZipBuffer(Buffer.from(await res.arrayBuffer()));
}

interface McpGenerateResult {
  readonly contentBase64: string;
  readonly isError: boolean;
}

async function mcpGenerate(args: Record<string, unknown>): Promise<McpGenerateResult> {
  const result = await handleGenerateDocx({ specId: testSpecId, ...args });
  if ('isError' in result && result.isError === true) {
    return { contentBase64: '', isError: true };
  }
  const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
  const data = JSON.parse(text) as { contentBase64: string };
  return { contentBase64: data.contentBase64, isError: false };
}

async function mcpDocParts(args: Record<string, unknown> = {}): Promise<DocParts> {
  const { contentBase64, isError } = await mcpGenerate(args);
  if (isError) throw new Error('MCP generate_docx returned isError');
  return docPartsFromZipBuffer(Buffer.from(contentBase64, 'base64'));
}

describe('generate_docx <-> POST /specs/:id/generate byte-parity (#567)', () => {
  it('no optional body params -> document.xml + numbering.xml identical between MCP and REST', async () => {
    const rest = await restDocParts({});
    const mcp = await mcpDocParts();
    expect(mcp.documentXml).toBe(rest.documentXml);
    expect(mcp.numberingXml).toBe(rest.numberingXml);
  });

  it('sectionNumberFormat override -> identical parity', async () => {
    const rest = await restDocParts({ sectionNumberFormat: 'dots' });
    const mcp = await mcpDocParts({ sectionNumberFormat: 'dots' });
    expect(mcp.documentXml).toBe(rest.documentXml);
    expect(mcp.documentXml).toContain('27.14.23');
  });

  it("unknown spec -> isError without throwing (handleGenerateDocx's own catch)", async () => {
    const result = await handleGenerateDocx({
      specId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toMatchObject({ isError: true });
  });
});

describe('generate_docx templateId resolution parity (#567)', () => {
  let defaultTemplateId: string;
  let customTemplateId: string;

  beforeAll(async () => {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM style_templates WHERE name = 'UFGS-Default'`
    );
    const row = r.rows[0];
    if (!row) throw new Error('UFGS-Default template missing — run migrations');
    defaultTemplateId = row.id;
    const custom = await createTemplateWithRules('MCP-Generate-Test-Custom', null, [
      {
        nodeType: 'part',
        properties: {
          rPr: { rFonts: { ascii: 'Arial' }, sz: 28 },
          pPr: { spacing: { before: 480, after: 60 } },
        },
      },
    ]);
    customTemplateId = custom.id;
  });

  afterAll(async () => {
    await deleteTemplate(customTemplateId);
  });

  it('explicit default templateId -> identical to a bare request (both routes)', async () => {
    const withDefault = await mcpDocParts({ templateId: defaultTemplateId });
    const bare = await mcpDocParts({});
    expect(withDefault.documentXml).toBe(bare.documentXml);
    expect(withDefault.numberingXml).toBe(bare.numberingXml);
  });

  it('custom templateId -> MCP output matches REST output for the same template', async () => {
    const rest = await restDocParts({ templateId: customTemplateId });
    const mcp = await mcpDocParts({ templateId: customTemplateId });
    expect(mcp.documentXml).toBe(rest.documentXml);
    expect(mcp.documentXml).toContain('Arial');
    expect(mcp.documentXml).toMatch(/w:sz[^/>]*w:val="28"/);
  });

  it('unknown templateId -> isError "template not found" (REST parity, no throw)', async () => {
    const result = await handleGenerateDocx({
      specId: testSpecId,
      templateId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain('template not found');
  });
});

describe('generate_docx sectionNumberFormat project-default parity (#567)', () => {
  let projectId: string;

  beforeAll(async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, section_number_format) VALUES ($1, $2) RETURNING id`,
      ['MCP Generate Format Project', 'dots']
    );
    const row = res.rows[0];
    if (!row) throw new Error('failed to insert project');
    projectId = row.id;
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
      [projectId, testSpecId]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  });

  it("no body format -> falls back to the owning project's stored default, matching REST", async () => {
    const rest = await restDocParts({});
    const mcp = await mcpDocParts({});
    expect(mcp.documentXml).toBe(rest.documentXml);
    expect(mcp.documentXml).toContain('27.14.23');
  });

  it('body format still wins over the project default, matching REST', async () => {
    const rest = await restDocParts({ sectionNumberFormat: 'canonical' });
    const mcp = await mcpDocParts({ sectionNumberFormat: 'canonical' });
    expect(mcp.documentXml).toBe(rest.documentXml);
    expect(mcp.documentXml).toContain('27 14 23');
  });
});
