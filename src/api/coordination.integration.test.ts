import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { setRequiredSections } from '../db/queries/required-sections.js';

let server: Server;
let baseUrl: string;
let projectId: string;
let specId: string;
const suffix = randomUUID().slice(0, 8);
// Extra project/spec ids created by individual tests, cleaned up in afterAll.
const extraProjectIds: string[] = [];
const extraSpecIds: string[] = [];

async function req(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 3000}`;

  const p = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`coord-api-${suffix}`]
  );
  projectId = p.rows[0]!.id;
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('05 12 00', 'Steel', $1, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [`coordapi_${suffix}`]
  );
  specId = spec.rows[0]!.id;
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`, [
    projectId,
    specId,
  ]);
  await setRequiredSections({ kind: 'baseline', projectId }, [{ section: '07 92 00' }]);
});

afterAll(async () => {
  // Projects first (cascade project_specs + required_sections), then library specs
  // (cascade their paragraphs + spec_references).
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [
    [projectId, ...extraProjectIds],
  ]);
  await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [[specId, ...extraSpecIds]]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('coordination-report API', () => {
  it('GET returns the report envelope with findings + summary', async () => {
    const r = await req('GET', `/projects/${projectId}/coordination-report`);
    expect(r.status).toBe(200);
    const body = r.body as {
      success: boolean;
      data: { summary: { total: number }; findings: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.summary.total).toBe(body.data.findings.length);
    // present 05 12 00 (not required) + required 07 92 00 (absent) = 2 findings
    expect(body.data.summary.total).toBe(2);
  });

  it('#259: a body section ref with no Related Sections entry surfaces related_cited_not_listed', async () => {
    const p = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
      [`coord-api-a2-${suffix}`]
    );
    const pid = p.rows[0]!.id;
    extraProjectIds.push(pid);
    const spec = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('26 27 26', 'Wiring Devices', $1, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
       RETURNING id`,
      [`coordapi2_${suffix}`]
    );
    const sid = spec.rows[0]!.id;
    extraSpecIds.push(sid);
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, 1)`,
      [pid, sid]
    );
    const para = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position)
       VALUES ($1, 'pr1', 'Coordinate with Section 26 05 33', 1) RETURNING id`,
      [sid]
    );
    await pool.query(
      `INSERT INTO spec_references
         (source_spec_id, source_paragraph_id, target_type, target_spec_section, reference_text)
       VALUES ($1, $2, 'section', '26 05 33', 'Section 26 05 33')`,
      [sid, para.rows[0]!.id]
    );

    const r = await req('GET', `/projects/${pid}/coordination-report`);
    expect(r.status).toBe(200);
    const body = r.body as {
      data: {
        summary: { relatedCitedNotListed: number };
        findings: { type: string; section?: string }[];
      };
    };
    expect(body.data.summary.relatedCitedNotListed).toBe(1);
    const a2 = body.data.findings.filter((f) => f.type === 'related_cited_not_listed');
    expect(a2.map((f) => f.section)).toEqual(['26 05 33']);
  });

  it('400 on a malformed project id', async () => {
    expect((await req('GET', `/projects/not-a-uuid/coordination-report`)).status).toBe(400);
  });

  it('400 on a malformed packageId query', async () => {
    expect(
      (await req('GET', `/projects/${projectId}/coordination-report?packageId=not-a-uuid`)).status
    ).toBe(400);
  });

  it('404 on an unknown project', async () => {
    expect(
      (await req('GET', `/projects/00000000-0000-4000-8000-000000000000/coordination-report`))
        .status
    ).toBe(404);
  });

  it('404 on a packageId not in the project', async () => {
    expect(
      (
        await req(
          'GET',
          `/projects/${projectId}/coordination-report?packageId=00000000-0000-4000-8000-000000000000`
        )
      ).status
    ).toBe(404);
  });
});
