import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, insertTree } from '../db/index.js';
import type { SpecNode, SpecTree } from '../ast/index.js';

let server: Server;
let baseUrl: string;
let companyId: string;
let projectId: string;
let concreteId: string;
let paintingId: string;
let controlsId: string;
let packageId: string;
let baseRevisionId: string;
let addendumRevisionId: string;

const projectIds: string[] = [];
const masterIds: string[] = [];

async function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function data(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json()) as Record<string, unknown>)['data'] as Record<string, unknown>;
}

function pr1(text: string): SpecNode {
  return { id: randomUUID(), type: 'pr1', text, children: [], meta: {} };
}

function smallTree(specId: string, section: string, title: string, body: string): SpecTree {
  return {
    id: specId,
    section,
    title,
    parts: [
      {
        id: randomUUID(),
        type: 'part',
        text: 'GENERAL',
        children: [
          {
            id: randomUUID(),
            type: 'article',
            text: 'SUMMARY',
            children: [pr1(body)],
            meta: {},
          },
        ],
        meta: {},
      },
    ],
  };
}

async function insertMasterWithTree(section: string, title: string, body: string): Promise<void> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, companyId]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`failed to insert master ${section}`);
  masterIds.push(row.id);
  await insertTree(smallTree(row.id, section, title, body), row.id, pool);
}

async function addSection(section: string): Promise<string> {
  const res = await json('POST', `/projects/${projectId}/specs`, { section });
  const body = await data(res);
  return body['specId'] as string;
}

async function getDocXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
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
  baseUrl = `http://localhost:${typeof address === 'object' && address !== null ? address.port : 3000}`;

  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master'`
  );
  if (!lib.rows[0]) throw new Error('Default Company Master missing - run migrations');
  companyId = lib.rows[0].id;

  await insertMasterWithTree('03 30 00', 'Cast-in-Place Concrete', 'Original concrete text.');
  await insertMasterWithTree('09 91 00', 'Painting', 'Original painting text.');
  await insertMasterWithTree('23 09 23', 'Direct Digital Control', 'Original controls text.');

  const created = await json('POST', '/projects', {
    name: `Revision Render P1 ${Date.now()}`,
    description: 'Snapshot render project',
    sourceLibraryIds: [companyId],
  });
  projectId = (await data(created))['projectId'] as string;
  projectIds.push(projectId);

  concreteId = await addSection('03 30 00');
  paintingId = await addSection('09 91 00');
  controlsId = await addSection('23 09 23');

  const pkg = await json('POST', `/projects/${projectId}/packages`, { name: 'CD Set' });
  packageId = (await data(pkg))['packageId'] as string;
  const membership = await json('PUT', `/packages/${packageId}/specs`, {
    specIds: [concreteId, paintingId, controlsId],
  });
  if (membership.status !== 200) throw new Error('failed to set package membership');

  const base = await json('POST', `/packages/${packageId}/revisions`, { label: '100% CD' });
  baseRevisionId = (await data(base))['revisionId'] as string;

  await pool.query(
    `UPDATE paragraphs SET text = 'Changed painting text for addendum.'
     WHERE spec_id = $1 AND node_type = 'pr1'`,
    [paintingId]
  );

  const addendum = await json('POST', `/packages/${packageId}/revisions`, {
    label: 'Addendum 1',
  });
  addendumRevisionId = (await data(addendum))['revisionId'] as string;
});

afterAll(async () => {
  await pool.query('DELETE FROM design_packages WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM project_specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE project_id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM projects WHERE id = ANY($1)', [projectIds]);
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [masterIds]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /revisions/:id/generate', () => {
  it('re-renders an old revision from frozen content after live DB edits', async () => {
    const res = await json('POST', `/revisions/${baseRevisionId}/generate`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
    expect(xml).toContain('100% CD');
    expect(xml).toContain('CD Set');
    expect(xml).toContain('Original painting text.');
    expect(xml).not.toContain('Changed painting text for addendum.');
    expect(xml).not.toContain('<w:headerReference');
    expect(xml).not.toContain('<w:footerReference');
  });

  it('addendum mode renders exactly the section changed since the base revision', async () => {
    const res = await json('POST', `/revisions/${addendumRevisionId}/generate`, {
      baseRevisionId,
    });
    expect(res.status).toBe(200);

    const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
    expect(xml).toContain('Addendum 1');
    expect(xml).toContain('Affected Sections');
    expect(xml).toContain('09 91 00 - Painting');
    expect(xml).toContain('SECTION 09 91 00');
    expect(xml).toContain('Changed painting text for addendum.');
    expect(xml).not.toContain('SECTION 03 30 00');
    expect(xml).not.toContain('SECTION 23 09 23');
    expect(xml).not.toContain('Original concrete text.');
    expect(xml).not.toContain('Original controls text.');
    expect(xml).not.toContain('<w:headerReference');
    expect(xml).not.toContain('<w:footerReference');
  });
});
