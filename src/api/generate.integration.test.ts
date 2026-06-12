import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createTemplateWithRules, deleteTemplate } from '../db/index.js';

let server: Server;
let baseUrl: string;
let testSpecId: string;
let testPartId: string;

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

  // Insert a spec with one part and one article for the round-trip smoke test
  const specRes = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    ['27 13 23', 'Structured Cabling Generate Test', 'ufgs']
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
  testPartId = partRow.id;

  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, $2, 'article', 'REFERENCES', 1, false)`,
    [testSpecId, testPartId]
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

describe('POST /specs/:id/generate (integration)', () => {
  it('returns 200 with DOCX content-type for existing spec', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('.docx');
  });

  it('returns a non-empty body (valid DOCX bytes)', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.length).toBeGreaterThan(0);
    // DOCX files start with PK (ZIP magic bytes)
    expect(buffer[0]).toBe(0x50); // 'P'
    expect(buffer[1]).toBe(0x4b); // 'K'
  });

  it('returns 404 for unknown spec UUID', async () => {
    const res = await fetch(`${baseUrl}/specs/00000000-0000-0000-0000-000000000000/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
  });

  it('returns 400 for malformed (non-UUID) spec id', async () => {
    const res = await fetch(`${baseUrl}/specs/not-a-uuid/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body['success']).toBe(false);
    expect(typeof body['error']).toBe('string');
  });
});

interface DocParts {
  readonly documentXml: string;
  readonly numberingXml: string;
}

// Identity comparison covers numbering.xml too — template numbering overrides
// route through it, so a default-resolution regression could leave document.xml
// unchanged while the numbering definitions diverge.
async function fetchDocParts(specId: string, body: Record<string, unknown>): Promise<DocParts> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`generate failed: ${res.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const documentFile = zip.file('word/document.xml');
  const numberingFile = zip.file('word/numbering.xml');
  if (!documentFile) throw new Error('document.xml missing');
  if (!numberingFile) throw new Error('numbering.xml missing');
  return {
    documentXml: await documentFile.async('string'),
    numberingXml: await numberingFile.async('string'),
  };
}

describe('POST /specs/:id/generate — templateId (integration)', () => {
  let defaultTemplateId: string;
  let customTemplateId: string;

  beforeAll(async () => {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM style_templates WHERE name = 'UFGS-Default'`
    );
    const row = r.rows[0];
    if (!row) throw new Error('UFGS-Default template missing — run migrations');
    defaultTemplateId = row.id;
    const custom = await createTemplateWithRules('Generate-Test-Custom', null, [
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

  it('explicit default templateId → identical document.xml + numbering.xml to no-template request', async () => {
    const withDefault = await fetchDocParts(testSpecId, { templateId: defaultTemplateId });
    const without = await fetchDocParts(testSpecId, {});
    expect(withDefault.documentXml).toBe(without.documentXml);
    expect(withDefault.numberingXml).toBe(without.numberingXml);
  });

  it('custom template font/spacing values appear in document.xml', async () => {
    const { documentXml } = await fetchDocParts(testSpecId, { templateId: customTemplateId });
    expect(documentXml).toContain('Arial');
    expect(documentXml).toMatch(/w:sz[^/>]*w:val="28"/);
    expect(documentXml).toMatch(/w:spacing[^/>]*w:before="480"/);
  });

  it('custom template output differs from default output', async () => {
    const custom = await fetchDocParts(testSpecId, { templateId: customTemplateId });
    const def = await fetchDocParts(testSpecId, {});
    expect(custom.documentXml).not.toBe(def.documentXml);
  });

  it('unknown templateId → 404', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: '00000000-0000-0000-0000-000000000000' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(404);
    expect(body['success']).toBe(false);
    expect(String(body['error'])).toContain('template');
  });

  it('malformed (non-UUID) templateId → 400', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: 'nope' }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(400);
    expect(body['success']).toBe(false);
  });
});
