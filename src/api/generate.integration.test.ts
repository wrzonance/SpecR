import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import {
  pool,
  createTemplateWithRules,
  deleteTemplate,
  upsertHeaderFooterConfig,
} from '../db/index.js';

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

async function specDocXml(specId: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) throw new Error(`generate failed: ${res.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

async function attachSpecToProject(name: string, specId: string, format: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, section_number_format) VALUES ($1, $2) RETURNING id`,
    [name, format]
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error(`failed to insert project ${name}`);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    id,
    specId,
  ]);
  return id;
}

describe('POST /specs/:id/generate — project default fallback (#267)', () => {
  it("falls back to the sole project's client/firm default when the project override is null", async () => {
    let clientId: string | undefined;
    let projectId: string | undefined;
    try {
      const client = await pool.query<{ id: string }>(
        `INSERT INTO clients (name, section_number_format) VALUES ($1, 'dots') RETURNING id`,
        ['Spec Firm Fallback Client']
      );
      clientId = client.rows[0]?.id;
      if (!clientId) throw new Error('failed to insert client');
      const project = await pool.query<{ id: string }>(
        `INSERT INTO projects (name, client_id, section_number_format)
         VALUES ($1, $2, NULL) RETURNING id`,
        ['Spec Firm Fallback Project', clientId]
      );
      projectId = project.rows[0]?.id;
      if (!projectId) throw new Error('failed to insert project');
      await pool.query(
        `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
        [projectId, testSpecId]
      );
      const xml = await specDocXml(testSpecId, {});
      expect(xml).toContain('SECTION 27.13.23');
    } finally {
      if (projectId) await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
      if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }
  });

  it("falls back to the spec's sole project section_number_format when the body omits it", async () => {
    const projectId = await attachSpecToProject('Spec Fallback Project', testSpecId, 'dots');
    try {
      const xml = await specDocXml(testSpecId, {});
      expect(xml).toContain('SECTION 27.13.23');
      expect(xml).not.toContain('SECTION 27 13 23');
    } finally {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  });

  it('request sectionNumberFormat still wins over the project default', async () => {
    const projectId = await attachSpecToProject('Spec Override Project', testSpecId, 'dots');
    try {
      const xml = await specDocXml(testSpecId, { sectionNumberFormat: 'canonical' });
      expect(xml).toContain('SECTION 27 13 23');
      expect(xml).not.toContain('SECTION 27.13.23');
    } finally {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  });

  it('belongs to two projects (ambiguous) → canonical, not an arbitrary project default', async () => {
    const p1 = await attachSpecToProject('Ambiguous A', testSpecId, 'dots');
    const p2 = await attachSpecToProject('Ambiguous B', testSpecId, 'compact');
    try {
      const xml = await specDocXml(testSpecId, {});
      expect(xml).toContain('SECTION 27 13 23');
      expect(xml).not.toContain('SECTION 27.13.23');
      expect(xml).not.toContain('SECTION 271323');
    } finally {
      await pool.query('DELETE FROM projects WHERE id = ANY($1)', [[p1, p2]]);
    }
  });

  it('orphan spec (no project) → canonical', async () => {
    const xml = await specDocXml(testSpecId, {});
    expect(xml).toContain('SECTION 27 13 23');
  });
});

function headerFooterPartNames(zip: JSZip): string[] {
  return Object.keys(zip.files).filter((name) => /^word\/(header|footer)\d+\.xml$/.test(name));
}

describe('POST /specs/:id/generate — header/footer resolution (#304)', () => {
  it("renders the sole owning project's configured header/footer, resolved to the project's name", async () => {
    const projectId = await attachSpecToProject('HF Configured Project', testSpecId, 'canonical');
    try {
      await upsertHeaderFooterConfig(
        { projectId },
        { header: { center: { content: [{ kind: 'projectName' }] } } }
      );
      const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
      expect(headerFooterPartNames(zip)).toContain('word/header1.xml');
      const headerFile = zip.file('word/header1.xml');
      if (!headerFile) throw new Error('word/header1.xml missing from generated DOCX');
      const headerXml = await headerFile.async('string');
      expect(headerXml).toContain('HF Configured Project');
    } finally {
      await pool.query('DELETE FROM header_footer_configs WHERE project_id = $1', [projectId]);
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  });

  it('sole owning project with zero configured layers → output stays byte-identical to the config-less baseline', async () => {
    const baseline = await specDocXml(testSpecId, {});
    const projectId = await attachSpecToProject('HF Unconfigured Project', testSpecId, 'canonical');
    try {
      const withProject = await specDocXml(testSpecId, {});
      expect(withProject).toBe(baseline);

      const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
      expect(headerFooterPartNames(zip)).toEqual([]);
    } finally {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
  });

  it('orphan spec (no project) → no header/footer parts emitted', async () => {
    const res = await fetch(`${baseUrl}/specs/${testSpecId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(headerFooterPartNames(zip)).toEqual([]);
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
