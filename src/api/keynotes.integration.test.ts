import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { randomUUID } from 'node:crypto';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server;
let baseUrl: string;

const suffix = randomUUID().slice(0, 8);
const libIds: string[] = [];
const projectIds: string[] = [];

let projectId: string; // has sources, TOC, and valid keynotes
let emptyProjectId: string; // exists, but no sources → no valid keynotes

async function insertLibrary(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company', $1) RETURNING id`,
    [name]
  );
  const row = r.rows[0];
  if (!row) throw new Error('insertLibrary failed');
  libIds.push(row.id);
  return row.id;
}

async function insertProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [name]
  );
  const row = r.rows[0];
  if (!row) throw new Error('insertProject failed');
  projectIds.push(row.id);
  return row.id;
}

async function addSource(project: string, library: string, priority: number): Promise<void> {
  await pool.query(
    `INSERT INTO project_sources (project_id, library_id, priority) VALUES ($1, $2, $3)`,
    [project, library, priority]
  );
}

async function addTocSection(project: string, section: string, position: number): Promise<void> {
  const spec = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, project_id) VALUES ($1, $2, 'arcat', $3) RETURNING id`,
    [section, `Title ${section}`, project]
  );
  const row = spec.rows[0];
  if (!row) throw new Error('addTocSection failed');
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1, $2, $3)`,
    [project, row.id, position]
  );
}

async function insertKeynote(
  library: string,
  code: string,
  description: string,
  section: string,
  parentCode: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO keynotes (library_id, code, parent_code, description, target_section)
     VALUES ($1, $2, $3, $4, $5)`,
    [library, code, parentCode, description, section]
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
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  const library = await insertLibrary(`Keynote Export Co ${suffix}`);
  projectId = await insertProject(`keynote-export-${suffix}`);
  await addSource(projectId, library, 1);
  await addTocSection(projectId, '88 77 01', 1); // in TOC

  // Two valid keynotes (target section in TOC) — a parent and its child.
  await insertKeynote(library, 'A-CEIL', 'Acoustical ceiling', '88 77 01', null);
  await insertKeynote(library, 'A-CEIL-1', 'Suspended panel', '88 77 01', 'A-CEIL');
  // Target section NOT in the project TOC → excluded from the export.
  await insertKeynote(library, 'Z-PAINT', 'Paint not in manual', '88 99 00', null);

  emptyProjectId = await insertProject(`keynote-empty-${suffix}`);
});

afterAll(async () => {
  await pool.query(`DELETE FROM keynotes WHERE library_id = ANY($1::uuid[])`, [libIds]);
  await pool.query(`DELETE FROM project_specs WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM project_sources WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM specs WHERE project_id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM projects WHERE id = ANY($1::uuid[])`, [projectIds]);
  await pool.query(`DELETE FROM libraries WHERE id = ANY($1::uuid[])`, [libIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('GET /projects/:id/keynotes', () => {
  it('keynotes: renders the exact tab-delimited body, hierarchy preserved, TOC filter applied', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/keynotes`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('content-disposition')).toContain('keynotes.txt');
    const body = await res.text();
    expect(body).toBe('A-CEIL\tAcoustical ceiling\nA-CEIL-1\tSuspended panel\tA-CEIL\n');
    // The keynote whose target section is absent from the TOC never appears.
    expect(body).not.toContain('Z-PAINT');
  });

  it('keynotes: a project with no valid keynotes returns 200 and an empty body', async () => {
    const res = await fetch(`${baseUrl}/projects/${emptyProjectId}/keynotes`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('keynotes: unknown project id returns 404', async () => {
    const res = await fetch(`${baseUrl}/projects/${randomUUID()}/keynotes`);
    expect(res.status).toBe(404);
  });

  it('keynotes: a non-UUID project id returns 400', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/keynotes`);
    expect(res.status).toBe(400);
  });
});
