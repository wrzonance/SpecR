import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import type { Template } from '../db/index.js';
import type { DerivationReport } from '../parser/index.js';

// ─── Fixture XML strings (module-level so builder functions stay branch-free) ──

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const CONTENT_TYPES_WITH_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const CONTENT_TYPES_PLAIN = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS_ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`;

const RELS_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

// word/styles.xml: docDefaults (Courier New, sz 20) + PRT + ART + PR1
const STYLES_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>
        <w:sz w:val="20"/>
      </w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="PRT">
    <w:name w:val="PRT"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="0"/>
        <w:numId w:val="2"/>
      </w:numPr>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:caps/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="ART">
    <w:name w:val="ART"/>
    <w:basedOn w:val="PRT"/>
    <w:pPr>
      <w:numPr>
        <w:ilvl w:val="1"/>
        <w:numId w:val="2"/>
      </w:numPr>
    </w:pPr>
    <w:rPr>
      <w:b w:val="0"/>
      <w:caps w:val="0"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="PR1">
    <w:name w:val="PR1"/>
    <w:basedOn w:val="PRT"/>
    <w:pPr>
      <w:ind w:left="720"/>
      <w:numPr>
        <w:ilvl w:val="2"/>
        <w:numId w:val="2"/>
      </w:numPr>
    </w:pPr>
    <w:rPr>
      <w:b w:val="0"/>
    </w:rPr>
  </w:style>
</w:styles>`;

// word/numbering.xml: abstractNum id=5 with pStyle-linked levels + num numId=2
const NUMBERING_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="5">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="PART %1 -"/>
      <w:pStyle w:val="PRT"/>
      <w:pPr/>
    </w:lvl>
    <w:lvl w:ilvl="1">
      <w:start w:val="1"/>
      <w:numFmt w:val="decimal"/>
      <w:lvlText w:val="%1.%2"/>
      <w:pStyle w:val="ART"/>
      <w:pPr/>
    </w:lvl>
    <w:lvl w:ilvl="2">
      <w:start w:val="1"/>
      <w:numFmt w:val="upperLetter"/>
      <w:lvlText w:val="%3."/>
      <w:pStyle w:val="PR1"/>
      <w:pPr/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="2">
    <w:abstractNumId w:val="5"/>
  </w:num>
</w:numbering>`;

// word/document.xml: PART heading (PRT), ART article, PR1 paragraphs, plain unstyled
const DOCUMENT_FIXTURE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="PRT"/>
        <w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>
      </w:pPr>
      <w:r><w:t>PART 1 - GENERAL</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="ART"/>
        <w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr>
      </w:pPr>
      <w:r><w:t>1.1 SUMMARY</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="PR1"/>
        <w:numPr><w:ilvl w:val="2"/><w:numId w:val="2"/></w:numPr>
      </w:pPr>
      <w:r><w:t>Quality requirements.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr>
        <w:pStyle w:val="PR1"/>
        <w:numPr><w:ilvl w:val="2"/><w:numId w:val="2"/></w:numPr>
      </w:pPr>
      <w:r><w:t>Submittal procedures.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr/>
      <w:r><w:t>Unstyled continuation paragraph.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

const STYLES_PLAIN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr/></w:rPrDefault>
  </w:docDefaults>
</w:styles>`;

const DOCUMENT_PLAIN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr/>
      <w:r><w:t>This is plain prose text with no structure.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr/>
      <w:r><w:t>Another plain paragraph with no numbering or styles.</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr/>
      <w:r><w:t>Yet another continuation paragraph.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`;

// ─── Fixture builders ─────────────────────────────────────────────────────────

async function buildFixtureDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_WITH_NUMBERING);
  zip.file('_rels/.rels', RELS_ROOT);
  zip.file('word/_rels/document.xml.rels', RELS_DOCUMENT);
  zip.file('word/styles.xml', STYLES_FIXTURE);
  zip.file('word/numbering.xml', NUMBERING_FIXTURE);
  zip.file('word/document.xml', DOCUMENT_FIXTURE);
  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

async function buildUnstylableDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_PLAIN);
  zip.file('_rels/.rels', RELS_ROOT);
  zip.file('word/_rels/document.xml.rels', RELS_DOCUMENT);
  zip.file('word/styles.xml', STYLES_PLAIN);
  zip.file('word/document.xml', DOCUMENT_PLAIN);
  const arrayBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(arrayBuffer);
}

// ─── Test setup ───────────────────────────────────────────────────────────────

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

const cleanupNames: string[] = [];

afterEach(async () => {
  for (const name of cleanupNames.splice(0)) {
    await pool.query(`DELETE FROM style_templates WHERE name = $1`, [name]);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function postImport(
  docxBuffer: Buffer,
  fields: { name?: string; owner?: string }
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(docxBuffer)], { type: DOCX_MIME }), 'template.docx');
  if (fields.name !== undefined) form.append('name', fields.name);
  if (fields.owner !== undefined) form.append('owner', fields.owner);
  return fetch(`${baseUrl}/templates/import`, { method: 'POST', body: form });
}

interface ImportSuccessBody {
  readonly success: true;
  readonly data: {
    readonly template: Template;
    readonly report: DerivationReport;
  };
}

interface ImportErrorBody {
  readonly success: false;
  readonly error: string;
}

interface StyleRule {
  readonly nodeType: string;
  readonly properties: {
    readonly rPr?: {
      readonly b?: boolean;
      readonly caps?: boolean;
      readonly rFonts?: { readonly ascii?: string };
      readonly sz?: number;
    };
    readonly pPr?: { readonly ind?: { readonly left?: number } };
  };
}

// Split into two helpers to keep each one under the complexity limit.
// Each `?.` counts as a branch; combining both rules in one function exceeds 10.

function assertPartRuleFidelity(rule: StyleRule): void {
  // PRT style has b and caps; inherits Courier New + sz 20 from docDefaults
  expect(rule.properties.rPr?.b).toBe(true);
  expect(rule.properties.rPr?.caps).toBe(true);
  expect(rule.properties.rPr?.rFonts?.ascii).toBe('Courier New');
  expect(rule.properties.rPr?.sz).toBe(20);
}

function assertPr1RuleFidelity(rule: StyleRule): void {
  // PR1 is basedOn PRT but overrides b=false; inherits ind left=720 from its own pPr
  expect(rule.properties.rPr?.b).toBe(false);
  expect(rule.properties.pPr?.ind?.left).toBe(720);
}

function assertFidelity(rules: readonly StyleRule[]): void {
  const partRule = rules.find((r) => r.nodeType === 'part');
  if (!partRule) throw new Error('expected part rule');
  assertPartRuleFidelity(partRule);

  const pr1Rule = rules.find((r) => r.nodeType === 'pr1');
  if (!pr1Rule) throw new Error('expected pr1 rule');
  assertPr1RuleFidelity(pr1Rule);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /templates/import', () => {
  it('201 happy path — returns template + report, persists to DB', async () => {
    const buf = await buildFixtureDocx();
    const templateName = `test-import-happy-${Date.now()}`;
    cleanupNames.push(templateName);

    const res = await postImport(buf, { name: templateName, owner: 'test-owner' });
    expect(res.status).toBe(201);

    const body = (await res.json()) as ImportSuccessBody;
    expect(body.success).toBe(true);
    expect(body.data.template.name).toBe(templateName);
    expect(body.data.template.owner).toBe('test-owner');
    expect(Array.isArray(body.data.template.rules)).toBe(true);
    expect(body.data.template.rules.length).toBeGreaterThan(0);

    // Every nodeType in the rules must be one of the 7 valid StyleNodeTypes
    const validNodeTypes = new Set(['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5']);
    for (const rule of body.data.template.rules) {
      expect(validNodeTypes.has(rule.nodeType)).toBe(true);
    }

    // Report must contain nodeTypes
    expect(Array.isArray(body.data.report.nodeTypes)).toBe(true);
    expect(body.data.report.nodeTypes.length).toBeGreaterThan(0);

    // Verify template persisted in DB
    const dbResult = await pool.query<{ name: string }>(
      `SELECT name FROM style_templates WHERE name = $1`,
      [templateName]
    );
    expect(dbResult.rows).toHaveLength(1);
  });

  it('201 end-to-end fidelity — derived values match fixture styles', async () => {
    const buf = await buildFixtureDocx();
    const templateName = `test-import-fidelity-${Date.now()}`;
    cleanupNames.push(templateName);

    const res = await postImport(buf, { name: templateName });
    expect(res.status).toBe(201);

    const body = (await res.json()) as ImportSuccessBody;
    assertFidelity(body.data.template.rules);
  });

  it('409 when template name already exists', async () => {
    const buf = await buildFixtureDocx();
    const templateName = `test-import-dup-${Date.now()}`;
    cleanupNames.push(templateName);

    const first = await postImport(buf, { name: templateName });
    expect(first.status).toBe(201);

    const second = await postImport(buf, { name: templateName });
    expect(second.status).toBe(409);
    const body = (await second.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
    expect(body.error).toBe('template name already exists');
  });

  it('400 when name field is missing', async () => {
    const buf = await buildFixtureDocx();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: DOCX_MIME }), 'template.docx');
    const res = await fetch(`${baseUrl}/templates/import`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
  });

  it('400 when name field is empty string', async () => {
    const buf = await buildFixtureDocx();
    const res = await postImport(buf, { name: '' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
  });

  it('400 when no file is provided', async () => {
    const form = new FormData();
    form.append('name', 'some-name');
    const res = await fetch(`${baseUrl}/templates/import`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
    expect(body.error).toBe('file required');
  });

  it('400 when file has .txt extension', async () => {
    const buf = await buildFixtureDocx();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: 'text/plain' }), 'template.txt');
    form.append('name', 'some-name');
    const res = await fetch(`${baseUrl}/templates/import`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
    expect(body.error).toBe('unsupported file extension — only .docx is accepted');
  });

  it('422 when document has no styleable paragraphs', async () => {
    const buf = await buildUnstylableDocx();
    const templateName = `test-import-unstylable-${Date.now()}`;
    // no cleanup needed — should never be persisted

    const res = await postImport(buf, { name: templateName });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ImportErrorBody;
    expect(body.success).toBe(false);
    expect(body.error).toContain('no styleable paragraphs');
  });
});
