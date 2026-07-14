import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';
import type { SpecNode } from '../ast/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.end();
});

// Test libraries (and their cascade) are namespaced by a reserved prefix.
// Order matters: capture the derived template ids, drop the specs (which clears
// the specs.style_template_id FK), then drop the now-orphaned templates.
afterEach(async () => {
  const templates = await pool.query<{ style_template_id: string }>(
    `SELECT style_template_id FROM specs
     WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-onboard-%')
       AND style_template_id IS NOT NULL`
  );
  await pool.query(
    `DELETE FROM specs WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lib-onboard-%')`
  );
  for (const row of templates.rows) {
    await pool.query(`DELETE FROM style_templates WHERE id = $1`, [row.style_template_id]);
  }
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lib-onboard-%'`);
});

interface OnboardingJobData {
  status: string;
  error?: string;
  result?: {
    specId: string;
    templateId: string | null;
    report: {
      styleDerivation: unknown;
      styleSourceNeeded: boolean;
      headerFooter: unknown;
      editability: { counts: Record<string, number>; lowConfidence: unknown[] };
      hierarchy: {
        counts: { scored: number; unscored: number; belowThreshold: number };
        unscoredReason?: string;
        lowConfidence: unknown[];
      };
      parseWarnings: unknown[];
    };
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

async function importFile(
  libraryId: string,
  bytes: Buffer,
  name: string,
  type: string
): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetch(`${baseUrl}/libraries/${libraryId}/import`, {
    method: 'POST',
    body: form,
  });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { data: { jobId: string } };
  return body.data.jobId;
}

describe('POST /libraries/:id/import (O-8)', () => {
  it('DOCX import → completes with all three report sections + spec/template/classifications in DB', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-onboard-docx', owner: 'o' });
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
    const jobId = await importFile(lib.id, docx, 'sample.docx', DOCX_MIME);
    const job = await waitForJob(jobId);
    expect(job.status, job.error).toBe('complete');
    const r = job.result;
    expect(r).toBeDefined();
    if (!r) throw new Error('no result');
    // three sections present
    expect(r.report.styleDerivation).not.toBeNull();
    expect(r.report.styleSourceNeeded).toBe(false);
    expect(r.report.editability).toBeDefined();
    expect(Array.isArray(r.report.parseWarnings)).toBe(true);
    // #307: fixture has no header/footer parts — draft is always present as a
    // key on the report (null-collapse of SpecTree.headerFooter), never absent.
    expect('headerFooter' in r.report).toBe(true);
    expect(r.report.headerFooter).toBeNull();
    // ADR-055 hierarchy section: every structural DOCX paragraph is scored
    expect(r.report.hierarchy.counts.scored).toBeGreaterThan(0);
    expect(r.report.hierarchy.counts.unscored).toBe(0);
    expect(r.report.hierarchy.counts.belowThreshold).toBeGreaterThanOrEqual(0);
    expect(r.templateId).not.toBeNull();
    // spec landed in the target library with the derived template linked
    const spec = await pool.query<{ library_id: string; style_template_id: string | null }>(
      `SELECT library_id, style_template_id FROM specs WHERE id = $1`,
      [r.specId]
    );
    expect(spec.rows[0]?.library_id).toBe(lib.id);
    expect(spec.rows[0]?.style_template_id).toBe(r.templateId);
    // classifications persisted
    const classified = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1 AND classification IS NOT NULL`,
      [r.specId]
    );
    expect(parseInt(classified.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
    // ADR-055 roundtrip: provenance persisted, meta.inference derived on read
    const treeRes = await fetch(`${baseUrl}/specs/${r.specId}`);
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { data: { parts: SpecNode[] } };
    const collect = (nodes: readonly SpecNode[]): SpecNode[] =>
      nodes.flatMap((n) => [n, ...collect(n.children)]);
    const nodes = collect(treeBody.data.parts);
    const structural = nodes.filter(
      (n) => !['note', 'continuation'].includes(n.type) && n.meta.vanish !== true
    );
    expect(structural.length).toBeGreaterThan(0);
    for (const n of structural) {
      expect(n.meta.inference, `node ${n.id} (${n.type}) unscored`).toBeDefined();
      expect(n.meta.inference!.confidence).toBeGreaterThanOrEqual(0);
      expect(n.meta.inference!.confidence).toBeLessThanOrEqual(1);
    }
    for (const n of nodes.filter((x) => ['note', 'continuation'].includes(x.type))) {
      expect(n.meta.inference).toBeUndefined();
    }
  }, 40_000);

  it('.sec import works and flags styleSourceNeeded instead of failing', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-onboard-sec', owner: 'o' });
    const sec = readFileSync(resolve('docs/references/UFGS/DIVISION_01/01_11_00.SEC'));
    const jobId = await importFile(lib.id, sec, '01_11_00.sec', 'text/plain');
    const job = await waitForJob(jobId);
    expect(job.status, job.error).toBe('complete');
    expect(job.result?.report.styleSourceNeeded).toBe(true);
    expect(job.result?.report.styleDerivation).toBeNull();
    expect(job.result?.templateId).toBeNull();
    // ADR-055: SEC structure is explicit — unscored by design, never suspect
    expect(job.result?.report.hierarchy.counts.scored).toBe(0);
    expect(job.result?.report.hierarchy.counts.unscored).toBeGreaterThan(0);
    expect(job.result?.report.hierarchy.unscoredReason).toContain('explicit structure');
  }, 40_000);

  it('re-import: editing a DOCX master updates the style template + report shows styleSourceNeeded:false', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-onboard-reimport', owner: 'o' });
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));

    // First import → derives + links a style template.
    const firstJob = await waitForJob(await importFile(lib.id, docx, 'sample.docx', DOCX_MIME));
    expect(firstJob.status, firstJob.error).toBe('complete');
    const templateId = firstJob.result?.templateId;
    expect(templateId).not.toBeNull();
    if (!templateId) throw new Error('first import produced no template');

    // Simulate an out-of-date template: blow away the derived rules. A correct
    // re-import must restore them from the fresh derivation, not leave them empty.
    await pool.query(`DELETE FROM style_rules WHERE template_id = $1`, [templateId]);
    const empty = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM style_rules WHERE template_id = $1`,
      [templateId]
    );
    expect(parseInt(empty.rows[0]?.count ?? '0', 10)).toBe(0);

    // Re-import the SAME master into the SAME library → same specId (ON CONFLICT
    // upsert) → same deterministic template name. The report must still reflect a
    // present, current style source — never falsely flag styleSourceNeeded.
    const secondJob = await waitForJob(await importFile(lib.id, docx, 'sample.docx', DOCX_MIME));
    expect(secondJob.status, secondJob.error).toBe('complete');
    const r = secondJob.result;
    if (!r) throw new Error('re-import produced no result');
    expect(r.report.styleSourceNeeded).toBe(false);
    expect(r.templateId).toBe(templateId); // same upserted template, not a new one
    expect(r.report.styleDerivation).not.toBeNull();

    // The spec's style source still resolves to the current template …
    const spec = await pool.query<{ style_template_id: string | null }>(
      `SELECT style_template_id FROM specs WHERE id = $1`,
      [r.specId]
    );
    expect(spec.rows[0]?.style_template_id).toBe(templateId);

    // … and its rules were refreshed (restored from the fresh derivation).
    const refreshed = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM style_rules WHERE template_id = $1`,
      [templateId]
    );
    expect(parseInt(refreshed.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  }, 60_000);

  it('unknown library → 404', async () => {
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), 'sample.docx');
    const res = await fetch(`${baseUrl}/libraries/00000000-0000-0000-0000-000000000000/import`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(404);
  });

  it('malformed upload (unsupported extension) → 400', async () => {
    const lib = await createLibrary({ tier: 'company', name: 'lib-onboard-bad', owner: 'o' });
    const form = new FormData();
    form.append('file', new Blob(['nope'], { type: 'text/plain' }), 'bad.xyz');
    const res = await fetch(`${baseUrl}/libraries/${lib.id}/import`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });

  it('invalid library id → 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const res = await fetch(`${baseUrl}/libraries/not-a-uuid/import`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });
});
