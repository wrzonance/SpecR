// src/api/onboarding-header-footer.integration.test.ts
//
// #307 (task 6/7): closes the review→save→re-render loop end-to-end, with
// zero new production code. Reuses the DOCX-generator round trip already
// established by generate-header-footer-parity.integration.test.ts (build a
// real DOCX via generateDocx, don't hand-author header/footer OOXML) rather
// than editing a fixture's zip parts directly.
//
// generateDocx doesn't stamp docProps/core.xml identity (no `title`/`subject`
// wired in GenerateDocxOptions — a pre-existing, orthogonal gap, not
// production code this issue touches), so a generated DOCX's header/footer
// literal text can never be recognized against the section it belongs to. A
// real Word/LibreOffice export always carries that identity; this test
// patches docProps/core.xml onto the generator's output the same way
// roundtrip.integration.test.ts patches word/document.xml — assembling a
// realistic test fixture, not simulating new capture logic.
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLibrary, pool } from '../db/index.js';
import { generateDocx } from '../generator/index.js';
import type { HeaderFooterComposition } from '../ast/index.js';
import type { SpecNode, SpecTree } from '../ast/types.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TEST_PREFIX = 'hfonboard-test-';
const SECTION = '27 21 00';
const TITLE = 'Structured Cabling';

let server: Server;
let baseUrl: string;
let libraryId: string;
let projectId: string;
let specId: string | undefined;

interface OnboardingReportShape {
  readonly headerFooter: HeaderFooterComposition | null;
}

interface OnboardingJobData {
  readonly status: string;
  readonly error?: string;
  readonly result?: {
    readonly specId: string;
    readonly report: OnboardingReportShape;
  };
}

async function waitForJob(jobId: string, maxMs = 25_000): Promise<OnboardingJobData> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/libraries/import/jobs/${jobId}`);
    const body = (await res.json()) as { data: OnboardingJobData };
    if (body.data.status === 'complete' || body.data.status === 'failed') return body.data;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`onboarding job ${jobId} did not finish`);
}

// Minimal part -> article -> pr1 body. NOTE: generateDocx wraps every body
// paragraph in a w:sdt merge anchor (round-trip-merge feature, ADR — content
// controls) that the fresh-import 5-signal classifier was never built to see
// through — real authored DOCX (ARCAT/CPI/UFGS) never carries them. Re-importing
// generator output therefore predictably logs 'no-structure-found'/
// 'root-continuation' body warnings; that is an orthogonal, pre-existing
// classifier/generator boundary, not something this header/footer test
// exercises or asserts on — captureHeaderFooter reads word/header*.xml,
// word/footer*.xml, and the trailing sectPr directly, entirely independent of
// how (or whether) the body classifies.
function buildFixtureTree(): SpecTree {
  const pr1: SpecNode = {
    id: randomUUID(),
    type: 'pr1',
    text: 'This Section includes minimum requirements for structured cabling pathways.',
    children: [],
    meta: {},
  };
  const article: SpecNode = {
    id: randomUUID(),
    type: 'article',
    text: 'SUMMARY',
    children: [pr1],
    meta: {},
  };
  const part: SpecNode = {
    id: randomUUID(),
    type: 'part',
    text: 'GENERAL',
    children: [article],
    meta: {},
  };
  return { id: randomUUID(), section: SECTION, title: TITLE, parts: [part] };
}

// Stamps the section/title identity the parser's matchKnownSectionField
// (#306, ADR-068) requires to recognize a literal header/footer text run as
// a typed sectionNumber/sectionTitle field — see the file-level comment.
async function withCoreIdentity(buffer: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:subject>${SECTION}</dc:subject>
  <dc:title>${TITLE}</dc:title>
</cp:coreProperties>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Builds a real DOCX (via the generator, #303/#304 machinery) whose footer
// carries exactly one typed field reference: {kind: 'sectionNumber'}.
async function buildFixtureDocx(): Promise<Buffer> {
  const composition: HeaderFooterComposition = {
    footer: { right: { content: [{ kind: 'sectionNumber' }] } },
  };
  const rendered = await generateDocx(buildFixtureTree(), undefined, {
    headerFooter: { composition, current: {} },
  });
  return withCoreIdentity(rendered);
}

async function docxPart(buffer: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file(name);
  if (!file) throw new Error(`${name} missing from generated DOCX`);
  return file.async('string');
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolveServer) => {
    server = app.listen(0, () => resolveServer());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  const library = await createLibrary({
    tier: 'company',
    name: `${TEST_PREFIX}library`,
    owner: 'o',
  });
  libraryId = library.id;
  const projectResult = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${TEST_PREFIX}project`]
  );
  const projectRow = projectResult.rows[0];
  if (!projectRow) throw new Error('failed to insert test project');
  projectId = projectRow.id;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.query(`DELETE FROM header_footer_configs WHERE project_id = $1`, [projectId]);
  if (specId !== undefined) {
    await pool.query(`DELETE FROM project_specs WHERE project_id = $1`, [projectId]);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  }
  await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  await pool.query(`DELETE FROM libraries WHERE id = $1`, [libraryId]);
});

describe('onboarding headerFooter draft — generator round trip (#307 AC2/AC3)', () => {
  it('preserves a typed sectionNumber field through import (no new persistence), and resolution picks it up on the next generate', async () => {
    // Precondition: nothing scoped to this project yet.
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM header_footer_configs WHERE project_id = $1`,
      [projectId]
    );
    expect(before.rows[0]?.count).toBe('0');

    const docx = await buildFixtureDocx();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), 'sample.docx');
    const importRes = await fetch(`${baseUrl}/libraries/${libraryId}/import`, {
      method: 'POST',
      body: form,
    });
    expect(importRes.status).toBe(202);
    const importBody = (await importRes.json()) as { data: { jobId: string } };
    const job = await waitForJob(importBody.data.jobId);
    expect(job.status, job.error).toBe('complete');
    const result = job.result;
    if (!result) throw new Error('import job produced no result');
    specId = result.specId;

    // AC #3: the typed field-kind reference is a pure pass-through of the
    // parser's capture — no literal text, no lossy re-derivation.
    expect(result.report.headerFooter).toEqual({
      variants: { default: { footer: { right: { content: [{ kind: 'sectionNumber' }] } } } },
    });

    // No new persistence: onboarding never writes header_footer_configs as a
    // side effect — the draft lives only on the job's TTL-scoped result.
    const afterImport = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM header_footer_configs WHERE project_id = $1`,
      [projectId]
    );
    expect(afterImport.rows[0]?.count).toBe('0');

    // AC #2: PUT the reviewed draft (unedited) to the spec's owning project
    // scope via the existing #480 route, then confirm the next /generate
    // call resolves it — closing review -> save -> re-render with zero new
    // production code.
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
      [projectId, specId]
    );
    const putRes = await fetch(`${baseUrl}/projects/${projectId}/header-footer`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result.report.headerFooter),
    });
    expect(putRes.status).toBe(200);

    const generateRes = await fetch(`${baseUrl}/specs/${specId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(generateRes.status).toBe(200);
    const generatedBuffer = Buffer.from(await generateRes.arrayBuffer());
    const footerXml = await docxPart(generatedBuffer, 'word/footer1.xml');
    expect(footerXml).toContain(SECTION);
  }, 40_000);
});
