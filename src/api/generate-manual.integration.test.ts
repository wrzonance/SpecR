import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';

let server: Server | undefined;
let baseUrl = '';
let projectId = '';
let specA = '';
let specB = '';

async function insertSpec(section: string, title: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    [section, title]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`failed to insert spec ${section}`);
  return row.id;
}

// One PART → ARTICLE chain so numbering has something to restart per section.
async function insertPartArticle(specId: string, articleText: string): Promise<void> {
  const part = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, NULL, 'part', 'GENERAL', 1, false) RETURNING id`,
    [specId]
  );
  const partId = part.rows[0]?.id;
  if (!partId) throw new Error('failed to insert part');
  await pool.query(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, vanish)
     VALUES ($1, $2, 'article', $3, 1, false)`,
    [specId, partId, articleText]
  );
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  const activeServer = await new Promise<Server>((resolve) => {
    const listeningServer = app.listen(0, () => resolve(listeningServer));
  });
  server = activeServer;
  const address = activeServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  specA = await insertSpec('03 30 00', 'Cast-in-Place Concrete Manual Test');
  specB = await insertSpec('09 91 00', 'Painting Manual Test');
  await insertPartArticle(specA, 'SUMMARY');
  await insertPartArticle(specB, 'REFERENCES');

  const projRes = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ('Manual Assembly Integration Test') RETURNING id`
  );
  const projRow = projRes.rows[0];
  if (!projRow) throw new Error('failed to insert project');
  projectId = projRow.id;
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2)`,
    [projectId, specA, specB]
  );
});

afterAll(async () => {
  if (projectId) {
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  }
  const specIds = [specA, specB].filter((id) => id.length > 0);
  if (specIds.length > 0) {
    await pool.query('DELETE FROM specs WHERE id = ANY($1)', [specIds]);
  }
  const activeServer = server;
  if (activeServer) {
    await new Promise<void>((resolve, reject) => {
      activeServer.close((err) => (err != null ? reject(err) : resolve()));
    });
  }
});

async function getDocXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('POST /projects/:id/generate — manual assembly (integration)', () => {
  it('streams a single DOCX containing both sections, numbering restarted per section', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(res.headers.get('content-disposition') ?? '').toContain('.docx');

    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer[0]).toBe(0x50); // 'P' — ZIP magic
    expect(buffer[1]).toBe(0x4b); // 'K'

    const xml = await getDocXml(buffer);
    expect(xml).toContain('SECTION 03 30 00');
    expect(xml).toContain('SECTION 09 91 00');
    expect(xml.indexOf('SECTION 03 30 00')).toBeLessThan(xml.indexOf('SECTION 09 91 00'));

    // Per-section numbering restart: each section uses a distinct numId instance.
    const distinctNumIds = new Set([...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]));
    expect(distinctNumIds.size).toBe(2);

    // Manual assembly must emit section boundaries in OOXML.
    const sectPrCount = (xml.match(/<w:sectPr\b/g) ?? []).length;
    expect(sectPrCount).toBeGreaterThanOrEqual(2);

    // Every emitted paragraph keeps its UUID anchor (2 parts + 2 articles = 4).
    expect((xml.match(/specr-uuid-/g) ?? []).length).toBe(4);

    // Front matter (ADR-017 D1): cover carries the project name, ahead of a TOC
    // field code, both before the first section.
    expect(xml).toContain('Manual Assembly Integration Test');
    expect(/instrText[^>]*>TOC .*\\o &quot;1-1&quot;/.exec(xml)).not.toBeNull();
    expect(xml.indexOf('Manual Assembly Integration Test')).toBeLessThan(
      xml.indexOf('SECTION 03 30 00')
    );
  });

  it("generate: honors the project's saved section_number_format when the body omits it (#267)", async () => {
    // Persist a non-default format on the project, then generate with an empty
    // body — the saved 'dots' default must flow through to the rendered titles.
    await pool.query(`UPDATE projects SET section_number_format = 'dots' WHERE id = $1`, [
      projectId,
    ]);
    try {
      const res = await fetch(`${baseUrl}/projects/${projectId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
      expect(xml).toContain('SECTION 03.30.00');
      expect(xml).toContain('SECTION 09.91.00');
      expect(xml).not.toContain('SECTION 03 30 00');
    } finally {
      await pool.query(`UPDATE projects SET section_number_format = 'canonical' WHERE id = $1`, [
        projectId,
      ]);
    }
  });

  it('generate: request sectionNumberFormat still wins over the project default (#267)', async () => {
    await pool.query(`UPDATE projects SET section_number_format = 'dots' WHERE id = $1`, [
      projectId,
    ]);
    try {
      const res = await fetch(`${baseUrl}/projects/${projectId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionNumberFormat: 'canonical' }),
      });
      expect(res.status).toBe(200);
      const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
      // Body 'canonical' overrides the project's 'dots'.
      expect(xml).toContain('SECTION 03 30 00');
      expect(xml).not.toContain('SECTION 03.30.00');
    } finally {
      await pool.query(`UPDATE projects SET section_number_format = 'canonical' WHERE id = $1`, [
        projectId,
      ]);
    }
  });

  it('returns 404 for an unknown project UUID', async () => {
    const res = await fetch(`${baseUrl}/projects/00000000-0000-0000-0000-000000000000/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('returns 422 for a project with no sections', async () => {
    const empty = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('Empty Manual Test') RETURNING id`
    );
    const emptyId = empty.rows[0]?.id;
    if (!emptyId) throw new Error('failed to insert empty project');
    try {
      const res = await fetch(`${baseUrl}/projects/${emptyId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(422);
    } finally {
      await pool.query('DELETE FROM projects WHERE id = $1', [emptyId]);
    }
  });

  it('returns 400 for a malformed project id', async () => {
    const res = await fetch(`${baseUrl}/projects/not-a-uuid/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
