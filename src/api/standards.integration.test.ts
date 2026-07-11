import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';

const suffix = randomUUID().slice(0, 8);
const ORG = `TSTB${suffix.toUpperCase()}`; // synthetic org isolates registry writes
const specIds: string[] = [];
let server: Server;
let baseUrl: string;
let projectId: string;
let libraryId: string;
let concreteId: string;

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, suffix, libraryId]
  );
  const id = r.rows[0]!.id;
  specIds.push(id);
  return id;
}

async function insertStandardRef(specId: string, standardCode: string): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1',$2,1) RETURNING id`,
    [specId, `cites ${standardCode}`]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, standard_code, reference_text)
     VALUES ($1,$2,'standard',$3,$4)`,
    [specId, p.rows[0]!.id, standardCode, standardCode]
  );
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

  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`Std API Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`Std API Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  concreteId = await insertSpec('03 30 00', 'Cast-in-Place Concrete');
  await insertStandardRef(concreteId, `${ORG} C150`);
  await insertStandardRef(concreteId, `${ORG} A653/A653M`);
  await pool.query(`INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1)`, [
    projectId,
    concreteId,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM standards WHERE org_code = $1`, [ORG]);
  if (projectId) await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  for (const id of specIds) await pool.query(`DELETE FROM specs WHERE id = $1`, [id]);
  if (libraryId) await pool.query(`DELETE FROM libraries WHERE id = $1`, [libraryId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await pool.end();
});

interface RollupBody {
  readonly data: {
    readonly standards: readonly {
      readonly orgCode: string;
      readonly standardCode: string;
      readonly status: string;
    }[];
    readonly findings: readonly { readonly standardCode: string; readonly type: string }[];
    readonly summary: { readonly standards: number; readonly superseded: number };
  };
}

describe('GET /libraries/{id}/standards & /projects/{id}/standards', () => {
  it('library rollup compiles cited standards and matches its documented schema', async () => {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/standards`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RollupBody;
    await assertResponse('get', '/libraries/{id}/standards', 200, body);
    expect(
      body.data.standards.map((s) => s.standardCode).sort((a, b) => a.localeCompare(b))
    ).toEqual(['A653/A653M', 'C150']);
    expect(body.data.summary.standards).toBe(2);
  });

  it('project rollup matches its documented schema', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/standards`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/projects/{id}/standards', 200, await res.json());
  });

  it('unknown scope id returns 404', async () => {
    const res = await fetch(`${baseUrl}/libraries/${randomUUID()}/standards`);
    expect(res.status).toBe(404);
  });

  it('malformed scope id returns 400', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/standards`);
    expect(res.status).toBe(400);
  });
});

describe('PUT /standards/{orgCode}/{standardCode}', () => {
  it('records a verdict, stamps last_verified_at, and matches the documented schema', async () => {
    const res = await fetch(`${baseUrl}/standards/${ORG}/C150`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'superseded', currentVersion: 'C150/C150M-22' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; lastVerifiedAt: string | null } };
    await assertResponse('put', '/standards/{orgCode}/{standardCode}', 200, body);
    expect(body.data.status).toBe('superseded');
    expect(body.data.lastVerifiedAt).not.toBeNull();
  });

  it('the verdict is reflected as a finding in the next rollup', async () => {
    const res = await fetch(`${baseUrl}/libraries/${libraryId}/standards`);
    const body = (await res.json()) as RollupBody;
    const c150 = body.data.standards.find((s) => s.standardCode === 'C150');
    expect(c150?.status).toBe('superseded');
    expect(
      body.data.findings.some((f) => f.standardCode === 'C150' && f.type === 'standard_superseded')
    ).toBe(true);
    expect(body.data.summary.superseded).toBe(1);
  });

  // ADR-064 §2: a standard code containing a slash (ASTM A653/A653M) must survive
  // the path when percent-encoded, so a client can record a verdict against it.
  it('percent-encoded standardCode with a slash round-trips', async () => {
    const encoded = encodeURIComponent('A653/A653M');
    const res = await fetch(`${baseUrl}/standards/${ORG}/${encoded}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'current' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { standardCode: string } };
    expect(body.data.standardCode).toBe('A653/A653M');

    const rollup = (await (
      await fetch(`${baseUrl}/libraries/${libraryId}/standards`)
    ).json()) as RollupBody;
    const row = rollup.data.standards.find((s) => s.standardCode === 'A653/A653M');
    expect(row?.status).toBe('current');
  });

  it('an invalid body (bad status enum) returns 422', async () => {
    const res = await fetch(`${baseUrl}/standards/${ORG}/C150`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'not-a-status' }),
    });
    expect(res.status).toBe(422);
  });

  // OpenAPI requestBody.required=false (ADR-064 §3): a no-body PUT (no
  // application/json header → req.body undefined) must record an empty verdict,
  // not 422. Regression for the missing-body path rejected by z.object().
  it('a no-body PUT records a verdict and defaults status to unknown', async () => {
    const res = await fetch(`${baseUrl}/standards/${ORG}/E119`, { method: 'PUT' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; lastVerifiedAt: string | null } };
    expect(body.data.status).toBe('unknown');
    expect(body.data.lastVerifiedAt).not.toBeNull();
  });
});
