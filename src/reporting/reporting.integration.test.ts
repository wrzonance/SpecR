import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { router } from '../api/router.js';
import { errorHandler } from '../api/middleware/error.js';
import { pool, addSectionToProject } from '../db/index.js';
import type { ComparisonReport } from './index.js';

type ApiOk = { success: true; data: ComparisonReport };
type ApiErr = { success: false; error: string };

// ── raw-SQL helpers (tests must not depend on the code under test for setup) ──

async function insertLibrary(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [name]
  );
  if (!r.rows[0]) throw new Error('insertLibrary failed');
  return r.rows[0].id;
}

async function insertMaster(libraryId: string, section: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id, content_version, origin_meta)
     VALUES ($1, 'Comparison Fixture', 'unknown', $2, 3, '{"filename":"x.docx","sha256":"abc","loader":"docx"}')
     RETURNING id`,
    [section, libraryId]
  );
  if (!r.rows[0]) throw new Error('insertMaster failed');
  return r.rows[0].id;
}

async function insertPara(
  specId: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [specId, parentId, nodeType, text, position]
  );
  if (!r.rows[0]) throw new Error('insertPara failed');
  return r.rows[0].id;
}

async function newProject(name: string, libraryId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  if (!r.rows[0]) throw new Error('newProject failed');
  const projectId = r.rows[0].id;
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, 1)`,
    [projectId, libraryId]
  );
  createdProjects.push(projectId);
  return projectId;
}

async function post(body: unknown): Promise<{ status: number; body: ApiOk | ApiErr }> {
  const res = await fetch(`${baseUrl}/reports/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ApiOk | ApiErr };
}

function okData(body: ApiOk | ApiErr): ComparisonReport {
  if (!body.success) throw new Error(`expected success, got: ${body.error}`);
  return body.data;
}

function driftMap(report: ComparisonReport): Map<string, number> {
  return new Map((report.drift ?? []).map((d) => [d.specId, d.behindBy]));
}

// ── fixture ──────────────────────────────────────────────────────────────────

const suffix = randomUUID().slice(0, 8);
const createdProjects: string[] = [];
let server: Server;
let baseUrl: string;
let companyLib: string;
let masterId: string;
let p1Spec: string;
let p2Spec: string;
const SECTION = '10 00 00';

async function findOriginClone(specId: string, originId: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM paragraphs WHERE spec_id = $1 AND origin_paragraph_id = $2`,
    [specId, originId]
  );
  if (!r.rows[0]) throw new Error('clone paragraph not found');
  return r.rows[0].id;
}

async function startServer(): Promise<void> {
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
}

async function seedFixture(): Promise<void> {
  companyLib = await insertLibrary(`Compare Co ${suffix}`);
  masterId = await insertMaster(companyLib, SECTION);
  const part = await insertPara(masterId, null, 'part', 'PART 1 GENERAL', 1);
  const article = await insertPara(masterId, part, 'article', 'SUMMARY', 1);
  const originPr1 = await insertPara(masterId, article, 'pr1', 'Original clause text.', 1);
  await insertPara(masterId, article, 'pr1', 'Second clause text.', 2);

  const proj1 = await newProject(`Compare P1 ${suffix}`, companyLib);
  const proj2 = await newProject(`Compare P2 ${suffix}`, companyLib);
  p1Spec = (await addSectionToProject(proj1, SECTION, pool)).specId;
  p2Spec = (await addSectionToProject(proj2, SECTION, pool)).specId;

  // Master advances after cloning → clones fall 2 versions behind (behindBy = 5 - 3).
  await pool.query(`UPDATE specs SET content_version = 5 WHERE id = $1`, [masterId]);

  // P2: modify the clone of originPr1, and add a NULL-origin paragraph (only-in-P2).
  const p2Pr1 = await findOriginClone(p2Spec, originPr1);
  await pool.query(`UPDATE paragraphs SET text = 'EDITED clause text.' WHERE id = $1`, [p2Pr1]);
  const p2Article = await pool.query<{ id: string }>(
    `SELECT id FROM paragraphs WHERE spec_id = $1 AND node_type = 'article' LIMIT 1`,
    [p2Spec]
  );
  await insertPara(p2Spec, p2Article.rows[0]?.id ?? null, 'pr1', 'Added-after-clone clause.', 3);
}

beforeAll(async () => {
  await startServer();
  await seedFixture();
});

afterAll(async () => {
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE project_id = ANY($1))',
    [createdProjects]
  );
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM project_sources WHERE project_id = ANY($1)', [createdProjects]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [createdProjects]);
  await pool.query(
    'DELETE FROM paragraphs WHERE spec_id IN (SELECT id FROM specs WHERE library_id = $1)',
    [companyLib]
  );
  await pool.query('DELETE FROM specs WHERE library_id = $1', [companyLib]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [companyLib]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('POST /reports/compare — project↔project', () => {
  it('grounds every present cell in a real spec + paragraph UUID and finds modified/only-in rows', async () => {
    const { status, body } = await post({ sources: [p1Spec, p2Spec] });
    expect(status).toBe(200);
    const report = okData(body);
    expect(report.columns.map((c) => c.specId)).toEqual([p1Spec, p2Spec]);

    const knownSpecs = new Set([p1Spec, p2Spec]);
    for (const row of report.rows) {
      for (const cell of row.cells) {
        if (!cell.present) continue;
        expect(knownSpecs.has(cell.specId)).toBe(true);
        expect(typeof cell.paragraphUuid).toBe('string');
        expect(typeof cell.text).toBe('string');
      }
    }

    // Modified row: both present, texts differ.
    const modified = report.rows.find(
      (r) => r.cells[0]?.present && r.cells[1]?.present && cellText(r, 0) !== cellText(r, 1)
    );
    expect(modified).toBeDefined();
    expect(modified && cellText(modified, 1)).toBe('EDITED clause text.');

    // Only-in-P2 row: absent in P1, present in P2.
    const onlyP2 = report.rows.find(
      (r) => r.cells[0]?.present === false && r.cells[1]?.present === true
    );
    expect(onlyP2).toBeDefined();
    expect(onlyP2 && cellText(onlyP2, 1)).toBe('Added-after-clone clause.');

    // Both clones are 2 versions behind their shared master.
    const drift = driftMap(report);
    expect(drift.get(p1Spec)).toBe(2);
    expect(drift.get(p2Spec)).toBe(2);
  });

  it('is deterministic: two identical requests return byte-identical bodies', async () => {
    const a = await post({ sources: [p1Spec, p2Spec] });
    const b = await post({ sources: [p1Spec, p2Spec] });
    expect(a.body).toEqual(b.body);
  });

  it('baseline lens tags the modified cell as modified', async () => {
    const { body } = await post({ sources: [p1Spec, p2Spec], baseline: p1Spec });
    const report = okData(body);
    expect(report.baseline).toBeDefined();
    expect(report.baseline?.specId).toBe(p1Spec);
    const hasModified = (report.baseline?.rows ?? []).some((r) => r.states.includes('modified'));
    expect(hasModified).toBe(true);
  });
});

describe('POST /reports/compare — project↔master and guards', () => {
  it('aligns a project clone against its master and surfaces behindBy drift', async () => {
    const { status, body } = await post({ sources: [p1Spec, masterId] });
    expect(status).toBe(200);
    const report = okData(body);
    // Every aligned row has both columns present (faithful clone vs master text).
    const bothPresent = report.rows.every((r) => r.cells[0]?.present && r.cells[1]?.present);
    expect(bothPresent).toBe(true);
    const drift = driftMap(report);
    expect(drift.get(p1Spec)).toBe(2);
    // The master has no parent → no drift entry for it.
    expect(drift.has(masterId)).toBe(false);
  });

  it('returns 404 when a source is not a live spec (frozen package/revision non-goal)', async () => {
    const { status, body } = await post({ sources: [randomUUID(), p1Spec] });
    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });

  it('returns 422 when a baseline is not one of the sources', async () => {
    const { status } = await post({ sources: [p1Spec, p2Spec], baseline: randomUUID() });
    expect(status).toBe(422);
  });
});

function cellText(row: ComparisonReport['rows'][number], index: number): string | undefined {
  const cell = row.cells[index];
  return cell?.present ? cell.text : undefined;
}
