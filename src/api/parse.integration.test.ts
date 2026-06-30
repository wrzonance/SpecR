import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import JSZip from 'jszip';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary, createNumberingProfile } from '../db/index.js';
import type { ParseWarning, SpecNode } from '../ast/types.js';
import type { NumberingProfile } from '../ast/index.js';

let server: Server;
let baseUrl: string;
const OCR_E2E_ENABLED = process.env['SPECR_OCR_E2E'] === '1';

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

interface JobResult {
  specId: string;
  section: string;
  title: string;
  nodeCount: number;
  capabilities?: string[];
  warnings?: ParseWarning[];
}

interface JobData {
  status: string;
  result?: JobResult;
  error?: string;
}

async function waitForJob(jobId: string, maxMs = 20_000): Promise<JobData> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/parse/jobs/${jobId}`);
    const body = (await res.json()) as { success: boolean; data: JobData };
    const job = body.data;
    if (job.status === 'complete' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`job ${jobId} did not complete within ${maxMs}ms`);
}

const cleanupIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  }
});

async function assertUfgsSpecInDb(specId: string): Promise<void> {
  const specResult = await pool.query<{ source: string }>(
    'SELECT source FROM specs WHERE id = $1',
    [specId]
  );
  expect(specResult.rows).toHaveLength(1);
  expect(specResult.rows[0]?.source).toBe('ufgs');
  const paraResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1',
    [specId]
  );
  expect(parseInt(paraResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
}

async function assertParagraphsStored(specId: string): Promise<void> {
  const paraResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1',
    [specId]
  );
  expect(parseInt(paraResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
}

function pdfObject(id: number, body: string): string {
  return `${id} 0 obj\n${body}\nendobj\n`;
}

function buildPdf(objects: readonly string[]): Buffer {
  const header = '%PDF-1.4\n';
  const offsets: number[] = [0];
  let body = '';
  for (const object of objects) {
    offsets.push(Buffer.byteLength(header + body, 'utf-8'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(header + body, 'utf-8');
  const xref = [
    `xref\n0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.slice(1).map((offset) => `${offset.toString().padStart(10, '0')} 00000 n `),
  ].join('\n');
  const trailer = `\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(`${header}${body}${xref}${trailer}`, 'utf-8');
}

function textPdf(lines: readonly string[]): Buffer {
  const escaped = lines.map((line) =>
    line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  );
  const textOps = escaped.map((line) => `(${line}) Tj T*`).join(' ');
  const stream = `BT /F1 12 Tf 20 TL 72 720 Td ${textOps} ET`;
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'
    ),
    pdfObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    pdfObject(
      5,
      `<< /Length ${Buffer.byteLength(stream, 'utf-8')} >>\nstream\n${stream}\nendstream`
    ),
  ]);
}

function blankPdf(): Buffer {
  return buildPdf([
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'),
  ]);
}

async function postPdf(buffer: Buffer): Promise<JobData> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), 'file.pdf');
  const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  expect(postRes.status).toBe(202);
  const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
  return waitForJob(postBody.data.jobId);
}

async function assertFailsForUnsupportedExtension(): Promise<void> {
  const form = new FormData();
  form.append('file', new Blob(['content'], { type: 'text/plain' }), 'file.xyz');
  const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
  // Security hardening (issue #22): unsupported extensions now rejected at the handler
  // before createJob — returns 400, no job created.
  expect(postRes.status).toBe(400);
  const postBody = (await postRes.json()) as { success: boolean; error: string; data?: unknown };
  expect(postBody.success).toBe(false);
  expect(typeof postBody.error).toBe('string');
  expect(postBody.data).toBeUndefined();
}

describe('POST /parse integration', () => {
  it('parses UFGS .sec file and stores paragraphs in DB', async () => {
    // Use UFGS .sec fixture — public domain, tracked in git, available in CI.
    const secContent = readFileSync(
      resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'),
      'utf-8'
    );
    const form = new FormData();
    form.append('file', new Blob([secContent], { type: 'text/plain' }), '01_11_00.sec');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);

    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    const { jobId } = postBody.data;
    expect(typeof jobId).toBe('string');

    const job = await waitForJob(jobId);
    expect(job.status).toBe('complete');

    const specId = job.result?.specId;
    expect(specId).toBeDefined();
    if (specId) {
      cleanupIds.push(specId);
      await assertUfgsSpecInDb(specId);
    }
  }, 30_000);

  it('returns 400 when no file provided', async () => {
    const res = await fetch(`${baseUrl}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('file required');
  });

  it('job fails gracefully for unsupported extension', async () => {
    await assertFailsForUnsupportedExtension();
  });

  it('parses text-layer PDF and stores paragraphs in DB', async () => {
    const fixture = textPdf([
      'SECTION 03 30 00 - CAST-IN-PLACE CONCRETE',
      'PART 1 - GENERAL',
      '1.1 SCOPE',
      'Cast-in-place concrete work.',
    ]);

    const job = await postPdf(fixture);
    expect(job.status).toBe('complete');
    const specId = job.result?.specId;
    expect(specId).toBeDefined();
    if (specId) {
      cleanupIds.push(specId);
      await assertParagraphsStored(specId);
    }
  }, 30_000);

  it.skipIf(!OCR_E2E_ENABLED)(
    'completes no-text PDF with an OCR warning instead of crashing',
    async () => {
      const job = await postPdf(blankPdf());
      expect(job.status).toBe('complete');
      expect(
        job.result?.warnings?.some(
          (warning) => warning.type === 'pdf-ocr-applied' || warning.type === 'pdf-ocr-unusable'
        )
      ).toBe(true);
      const specId = job.result?.specId;
      if (specId) cleanupIds.push(specId);
    }
  );

  it('GET /parse/jobs/:jobId returns 404 for unknown job', async () => {
    const res = await fetch(`${baseUrl}/parse/jobs/nonexistent-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('job not found');
  });
});

describe('POST /parse — refs persistence + replace-on-reparse (#53)', () => {
  async function postSecFixture(): Promise<string> {
    const secContent = readFileSync(
      resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'),
      'utf-8'
    );
    const form = new FormData();
    form.append('file', new Blob([secContent], { type: 'text/plain' }), '01_11_00.sec');
    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(postRes.status).toBe(202);
    const postBody = (await postRes.json()) as { success: boolean; data: { jobId: string } };
    const job = await waitForJob(postBody.data.jobId);
    expect(job.status).toBe('complete');
    const specId = job.result?.specId;
    if (!specId) throw new Error('expected specId in completed job result');
    return specId;
  }

  it('persists spec_references rows on API path (SEC fixture with SRF tags)', async () => {
    // Ensure clean slate — delete any spec from a previous test run that used the same fixture.
    await pool.query(`DELETE FROM specs WHERE section = '01 11 00' AND source = 'ufgs'`);
    const specId = await postSecFixture();
    cleanupIds.push(specId);

    const refsResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1',
      [specId]
    );
    const refCount = parseInt(refsResult.rows[0]?.count ?? '0', 10);
    expect(refCount).toBeGreaterThan(0);
  }, 30_000);

  it('re-POST same fixture returns same specId (upsert) and replaces paragraphs + refs', async () => {
    await pool.query(`DELETE FROM specs WHERE section = '01 11 00' AND source = 'ufgs'`);
    const firstSpecId = await postSecFixture();
    cleanupIds.push(firstSpecId);

    const firstParaIds = await pool.query<{ id: string }>(
      'SELECT id FROM paragraphs WHERE spec_id = $1 ORDER BY id',
      [firstSpecId]
    );
    expect(firstParaIds.rows.length).toBeGreaterThan(0);

    const secondSpecId = await postSecFixture();
    // Upsert: same row, same id.
    expect(secondSpecId).toBe(firstSpecId);

    const secondParaIds = await pool.query<{ id: string }>(
      'SELECT id FROM paragraphs WHERE spec_id = $1 ORDER BY id',
      [secondSpecId]
    );
    // Replace-on-reparse: old paragraph ids gone, new ids present.
    const firstSet = new Set(firstParaIds.rows.map((r) => r.id));
    const overlap = secondParaIds.rows.filter((r) => firstSet.has(r.id));
    expect(overlap).toEqual([]);

    // Refs still present after re-upload (deleted + reinserted).
    const refsResult = await pool.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1',
      [secondSpecId]
    );
    expect(parseInt(refsResult.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  }, 60_000);
});

describe('POST /parse — .txt upload', () => {
  it('accepts .txt file and returns 202 with jobId', async () => {
    const fixture = readFileSync(resolve('tests/fixtures/text/numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'numbered-prefixes.txt');

    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { success: boolean; data: { jobId: string } };
    expect(body.success).toBe(true);
    expect(typeof body.data.jobId).toBe('string');

    const job = await waitForJob(body.data.jobId);
    expect(job.status).toBe('complete');
    const specId = job.result?.specId;
    if (specId) {
      await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
    }
  }, 30_000);

  it('parse job completes with nodeCount > 0 and capabilities read-only', async () => {
    const fixture = readFileSync(resolve('tests/fixtures/text/numbered-prefixes.txt'));
    const form = new FormData();
    form.append('file', new Blob([fixture], { type: 'text/plain' }), 'test.txt');

    const postRes = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    const postBody = (await postRes.json()) as { data: { jobId: string } };

    const job = await waitForJob(postBody.data.jobId);
    if (job.status === 'failed') throw new Error('Parse job failed');
    const specId = job.result?.specId;
    if (specId) cleanupIds.push(specId);

    expect(job.result).toBeDefined();
    expect(job.result?.nodeCount ?? 0).toBeGreaterThan(0);
    expect(job.result?.capabilities).toContain('read-only');
  }, 30_000);

  it('rejects .xyz file with 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['content'], { type: 'text/plain' }), 'bad.xyz');
    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    expect(res.status).toBe(400);
  });
});

// A minimal numbering-driven .docx (built in-test, no committed binary): one
// abstractNum whose ilvl-0 lvlText literally declares "PART" (→ a spec-shaped
// numId), with paragraphs at ilvl 0/1/2/3 carrying plain text (no "1.1"-style
// prefixes), so structure is decided by Signal 1 (numbering), not Signal 4 (text).
// That makes it sensitive to an articleIlvl override — the only committed DOCX
// fixtures are text-driven and immune. With articleIlvl=2 the ilvl-2 paragraph
// shifts pr1→article (a structural disagreement that surfaces in meta.conflicts).
async function buildNumberingDrivenDocx(): Promise<Buffer> {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const lvl = (i: number, text: string): string =>
    `<w:lvl w:ilvl="${i}"><w:numFmt w:val="decimal"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const para = (ilvl: number, text: string): string =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${w}"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`
  );
  zip.file(
    'word/numbering.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="${w}"><w:abstractNum w:abstractNumId="0">${lvl(0, 'PART %1')}${lvl(1, '%1.0%2')}${lvl(2, '%1.0%2.%3')}${lvl(3, '%4')}</w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${w}"><w:body>${para(0, 'GENERAL')}${para(1, 'SUMMARY')}${para(2, 'Section includes work under this contract')}${para(3, 'Related requirements appear elsewhere')}</w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

function findNodeByText(nodes: readonly SpecNode[], prefix: string): SpecNode | undefined {
  for (const node of nodes) {
    if (node.text.startsWith(prefix)) return node;
    const found = findNodeByText(node.children, prefix);
    if (found) return found;
  }
  return undefined;
}

// #299 — an assigned numbering profile is resolved at the REST ingress, threaded
// into the parse worker, and applied to the production parse. These prove the full
// path: resolution + 404, the built-in default passing through unchanged, AND a real
// override deterministically reshaping the persisted tree + recording meta.conflicts.
describe('POST /parse — numbering profile (#299)', () => {
  const DOCX_FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  async function postDocx(fields: Record<string, string> = {}): Promise<{
    status: number;
    body: { success: boolean; error?: string; data?: { jobId: string } };
  }> {
    const buf = readFileSync(DOCX_FIXTURE);
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buf)], { type: DOCX_MIME }),
      'csi-spec-sample.docx'
    );
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    return {
      status: res.status,
      body: (await res.json()) as { success: boolean; error?: string; data?: { jobId: string } },
    };
  }

  async function builtInProfileId(): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM numbering_profiles WHERE library_id IS NULL LIMIT 1`
    );
    const id = row.rows[0]?.id;
    if (!id) throw new Error('built-in CSI Default profile missing — run seed/migrate');
    return id;
  }

  it('404 — a non-existent numberingProfileId is rejected before the job starts', async () => {
    const { status, body } = await postDocx({ numberingProfileId: randomUUID() });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error).toBe('numbering profile not found');
    expect(body.data).toBeUndefined(); // no job created
  });

  it('400 — a malformed numberingProfileId is rejected', async () => {
    const { status } = await postDocx({ numberingProfileId: 'not-a-uuid' });
    expect(status).toBe(400);
  });

  it('built-in CSI Default profile threads through and is a passthrough (same node count as no profile)', async () => {
    // No profile → baseline.
    const noProfile = await postDocx();
    expect(noProfile.status).toBe(202);
    const job0 = await waitForJob(noProfile.body.data!.jobId);
    expect(job0.status).toBe('complete');
    const specId = job0.result!.specId;
    cleanupIds.push(specId);
    const baselineCount = job0.result!.nodeCount;
    expect(baselineCount).toBeGreaterThan(0);

    // Built-in default (empty profile) → resolved, threaded to the worker, applied.
    const withDefault = await postDocx({ numberingProfileId: await builtInProfileId() });
    expect(withDefault.status).toBe(202);
    const job1 = await waitForJob(withDefault.body.data!.jobId);
    expect(job1.status).toBe('complete');
    // Same file → upsert to the same spec; empty default changes nothing (byte-for-byte).
    expect(job1.result!.specId).toBe(specId);
    expect(job1.result!.nodeCount).toBe(baselineCount);
  }, 30_000);

  // The full override path: a real numbering-driven document parsed twice through
  // POST /parse — once with no profile, once with a profile that sets articleIlvl=2.
  async function postBuffer(
    buffer: Buffer,
    fields: Record<string, string>
  ): Promise<{ status: number; body: { data?: { jobId: string } } }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), 'numbered.docx');
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    const res = await fetch(`${baseUrl}/parse`, { method: 'POST', body: form });
    return { status: res.status, body: (await res.json()) as { data?: { jobId: string } } };
  }

  async function fetchTree(specId: string): Promise<{ parts: readonly SpecNode[] }> {
    const res = await fetch(`${baseUrl}/specs/${specId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { parts: readonly SpecNode[] } };
    return body.data;
  }

  it('applies an assigned profile end-to-end — override reshapes the persisted tree + records meta.conflicts', async () => {
    const docx = await buildNumberingDrivenDocx();
    const SECTION = '09 91 23';
    // Same (section, source=unknown) upsert key across both uploads — start clean.
    await pool.query(`DELETE FROM specs WHERE section = $1 AND source = 'unknown'`, [SECTION]);

    // 1) No profile → baseline tiers (articleIlvl=1): "Section includes…" is pr1.
    const base = await postBuffer(docx, { section: SECTION });
    expect(base.status).toBe(202);
    const baseJob = await waitForJob(base.body.data!.jobId);
    expect(baseJob.status).toBe('complete');
    const specId = baseJob.result!.specId;
    cleanupIds.push(specId);
    const baseNode = findNodeByText((await fetchTree(specId)).parts, 'Section includes');
    expect(baseNode?.type).toBe('pr1');
    expect(baseNode?.meta.conflicts ?? []).toEqual([]);

    // 2) A profile that declares articleIlvl=2 (numId 5 stays spec-shaped).
    const lib = await createLibrary({ tier: 'client', name: `np-e2e-${randomUUID().slice(0, 8)}` });
    const overrideRules: NumberingProfile = {
      tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
      numbering: [{ numId: 5, levels: [{ ilvl: 0, tier: 'part' }] }],
      styleLadder: [],
      articleIlvl: 2,
    };
    const profile = await createNumberingProfile(lib.id, 'Shift articleIlvl', overrideRules);

    // 3) Re-parse the same file WITH the profile → upsert same spec, override applied.
    const withProfile = await postBuffer(docx, {
      section: SECTION,
      numberingProfileId: profile.id,
    });
    expect(withProfile.status).toBe(202);
    const ovJob = await waitForJob(withProfile.body.data!.jobId);
    expect(ovJob.status).toBe('complete');
    expect(ovJob.result!.specId).toBe(specId);

    // The override deterministically shifts pr1 → article, and the losing base
    // inference (pr1) is persisted as a conflict — never dropped.
    const ovNode = findNodeByText((await fetchTree(specId)).parts, 'Section includes');
    expect(ovNode?.type).toBe('article');
    expect(ovNode?.meta.conflicts?.length ?? 0).toBeGreaterThan(0);
  }, 30_000);
});
