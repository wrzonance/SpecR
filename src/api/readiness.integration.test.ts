import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';
import { pool } from '../db/index.js';
import type { SourceFacts } from '../ast/index.js';

// REST boundary coverage for ADR-079's dry-run readiness-report endpoints
// (#406). The pure evaluator (src/lib/readiness-review.test.ts) and the
// query layer (src/db/queries/readiness-report.integration.test.ts) already
// pin most invariants at their own layer; this file re-pins the three that
// only manifest once a real HTTP round trip and the actual error-mapping
// middleware are in play: the summary's per-kind counts stay in lockstep
// with findings.length after a real JSON response round trip (INV-9), an
// unknown spec/package id reaches the handler as the SAME `instanceof
// DatabaseError` subclass the query layer throws, so it maps to 404 and
// never falls through to the generic 500 branch a re-wrapped error would hit
// (INV-13), and package-scope aggregation attributes every finding to the
// correct member spec over the wire (INV-15, new at this boundary).

const suffix = randomUUID().slice(0, 8);
const projectIds: string[] = [];
const specIds: string[] = [];
let specCounter = 0;
let paraCounter = 0;
let server: Server;
let baseUrl: string;

async function req(method: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, { method });
  return { status: res.status, body: await res.json() };
}

async function newProject(name: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`${name}-${suffix}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newProject: no id');
  projectIds.push(id);
  return id;
}

async function newPackage(projectId: string, name: string, position: number): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, `${name}-${suffix}`, position]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('newPackage: no id');
  return id;
}

async function newSpec(section: string, title: string): Promise<string> {
  const src = `rr_api_${suffix}_${String(++specCounter).padStart(2, '0')}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, title, src]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}

async function addPackageSpec(packageId: string, specId: string, position: number): Promise<void> {
  await pool.query(
    `INSERT INTO package_specs (package_id, spec_id, position) VALUES ($1, $2, $3)`,
    [packageId, specId, position]
  );
}

interface ParaOptions {
  readonly nodeType?: string;
  readonly facts?: SourceFacts;
  readonly objectData?: Record<string, unknown>;
}

async function addParagraph(specId: string, text: string, opts: ParaOptions = {}): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs
       (id, spec_id, parent_id, node_type, text, position, source_facts, object_data)
     VALUES ($1, $2, NULL, $3, $4, $5, $6::jsonb, $7::jsonb)`,
    [
      id,
      specId,
      opts.nodeType ?? 'pr1',
      text,
      ++paraCounter,
      JSON.stringify(opts.facts ?? {}),
      opts.objectData ? JSON.stringify(opts.objectData) : null,
    ]
  );
  return id;
}

const textBoxObject = { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] };

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
});

afterAll(async () => {
  // Order matters: package_specs.spec_id is ON DELETE RESTRICT, so the
  // owning project (cascading through design_packages/package_specs) must go
  // before the specs it references.
  for (const id of projectIds) await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  for (const id of specIds) await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /specs/:id/readiness-report (#406)', () => {
  it('summary counts stay in lockstep with findings.length over the wire — INV-9', async () => {
    const specId = await newSpec('08 11 02', 'Metal Doors — API Summary');
    await addParagraph(specId, 'Provide <manufacturer> door.', {
      facts: { choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }] },
    });
    await addParagraph(specId, 'Note to specifier.', { nodeType: 'note' });
    await addParagraph(specId, 'Verify substrate.', {
      facts: { comments: [{ author: 'Jane', text: 'still open', anchor: [0, 5], closed: false }] },
    });
    await addParagraph(specId, '', { nodeType: 'object', objectData: textBoxObject });

    const r = await req('GET', `/specs/${specId}/readiness-report`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/specs/{id}/readiness-report', 200, r.body);

    const body = r.body as {
      data: {
        summary: {
          unresolvedChoiceToken: number;
          specifierNotePresent: number;
          openComment: number;
          bodyObjectPresent: number;
          total: number;
        };
        findings: readonly unknown[];
        readyForFinal: boolean;
      };
    };
    expect(body.data.summary).toEqual({
      unresolvedChoiceToken: 1,
      specifierNotePresent: 1,
      openComment: 1,
      bodyObjectPresent: 1,
      total: 4,
    });
    expect(body.data.findings).toHaveLength(body.data.summary.total);
    expect(body.data.readyForFinal).toBe(false);
  });

  it('readyForFinal: true and an all-zero summary for a clean spec', async () => {
    const specId = await newSpec('07 21 01', 'Thermal Insulation — API Clean');
    await addParagraph(specId, 'Provide batt insulation per manufacturer instructions.');

    const r = await req('GET', `/specs/${specId}/readiness-report`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/specs/{id}/readiness-report', 200, r.body);
    const body = r.body as { data: { readyForFinal: boolean; findings: readonly unknown[] } };
    expect(body.data.readyForFinal).toBe(true);
    expect(body.data.findings).toEqual([]);
  });

  it('400 on a malformed spec id', async () => {
    expect((await req('GET', '/specs/not-a-uuid/readiness-report')).status).toBe(400);
  });

  it('404 (not 500) on an unknown spec, carrying the SpecNotFoundError message — INV-13', async () => {
    const unknownId = randomUUID();
    const r = await req('GET', `/specs/${unknownId}/readiness-report`);
    expect(r.status).toBe(404);
    const body = r.body as { success: boolean; error: string };
    expect(body.success).toBe(false);
    // Pins that getReadinessReport's `instanceof DatabaseError` pass-through
    // (readiness-report.ts) lets SpecNotFoundError itself reach the handler
    // unchanged, so mapError's specific 404 branch fires — never the generic
    // 500 "readiness report failed" branch a re-wrapped error would hit.
    expect(body.error).toContain(unknownId);
  });
});

describe('GET /packages/:id/readiness-report (#406)', () => {
  it('aggregates findings across every member spec, correctly attributed — INV-15', async () => {
    const projectId = await newProject('readiness-api-multi');
    const packageId = await newPackage(projectId, 'API Multi Package', 1);
    const specA = await newSpec('26 05 02', 'Electrical Common — API Multi');
    const specB = await newSpec('08 11 03', 'Metal Doors — API Multi');
    await addPackageSpec(packageId, specA, 1);
    await addPackageSpec(packageId, specB, 2);
    const noteId = await addParagraph(specA, 'Coordinate with owner.', { nodeType: 'note' });
    const commentParaId = await addParagraph(specB, 'Verify substrate.', {
      facts: { comments: [{ author: 'Jane', text: 'still open', anchor: [0, 5], closed: false }] },
    });

    const r = await req('GET', `/packages/${packageId}/readiness-report`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/packages/{id}/readiness-report', 200, r.body);

    const body = r.body as {
      data: {
        readyForFinal: boolean;
        findings: readonly { type: string; nodeId: string; specId: string; specSection: string }[];
        summary: { total: number };
      };
    };
    expect(body.data.readyForFinal).toBe(false);
    expect(body.data.summary.total).toBe(2);
    const byNodeId = new Map(body.data.findings.map((f) => [f.nodeId, f]));
    expect(byNodeId.get(noteId)).toMatchObject({
      type: 'specifier_note_present',
      specId: specA,
      specSection: '26 05 02',
    });
    expect(byNodeId.get(commentParaId)).toMatchObject({
      type: 'open_comment',
      specId: specB,
      specSection: '08 11 03',
    });
  });

  it('readyForFinal: true when every member spec is clean', async () => {
    const projectId = await newProject('readiness-api-clean');
    const packageId = await newPackage(projectId, 'API Clean Package', 1);
    const specA = await newSpec('26 05 03', 'Electrical Common — API Clean');
    await addPackageSpec(packageId, specA, 1);
    await addParagraph(specA, 'Provide grounding per code.');

    const r = await req('GET', `/packages/${packageId}/readiness-report`);
    expect(r.status).toBe(200);
    await assertResponse('get', '/packages/{id}/readiness-report', 200, r.body);
    const body = r.body as { data: { readyForFinal: boolean } };
    expect(body.data.readyForFinal).toBe(true);
  });

  it('400 on a malformed package id', async () => {
    expect((await req('GET', '/packages/not-a-uuid/readiness-report')).status).toBe(400);
  });

  it('404 (not 500) on an unknown package, carrying the PackageNotFoundError message — INV-13', async () => {
    const unknownId = randomUUID();
    const r = await req('GET', `/packages/${unknownId}/readiness-report`);
    expect(r.status).toBe(404);
    const body = r.body as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain(unknownId);
  });
});
