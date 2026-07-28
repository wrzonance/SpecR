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

function note(text: string): SpecNode {
  return { id: randomUUID(), type: 'note', text, children: [], meta: {} };
}

// `bodyNodeType` defaults to 'pr1' (plain content) so every pre-existing call
// site is unaffected; 'note' produces an issuance-readiness-gate blocker
// (ADR-079, #406 — a specifier note always yields `specifier_note_present`).
function smallTree(
  specId: string,
  section: string,
  title: string,
  body: string,
  bodyNodeType: 'pr1' | 'note' = 'pr1'
): SpecTree {
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
            children: [bodyNodeType === 'note' ? note(body) : pr1(body)],
            meta: {},
          },
        ],
        meta: {},
      },
    ],
  };
}

async function insertMasterWithTree(
  section: string,
  title: string,
  body: string,
  bodyNodeType: 'pr1' | 'note' = 'pr1'
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'unknown', $3) RETURNING id`,
    [section, title, companyId]
  );
  const row = res.rows[0];
  if (!row) throw new Error(`failed to insert master ${section}`);
  masterIds.push(row.id);
  await insertTree(smallTree(row.id, section, title, body, bodyNodeType), row.id, pool);
  return row.id;
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
    type: 'addendum',
    attributes: { number: 1 },
    baseRevisionId,
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

  it('stored base renders the same addendum when the request body is empty', async () => {
    const res = await json('POST', `/revisions/${addendumRevisionId}/generate`, {});
    expect(res.status).toBe(200);
    const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
    expect(xml).toContain('Affected Sections');
    expect(xml).toContain('09 91 00 - Painting');
    expect(xml).not.toContain('SECTION 03 30 00');
    expect(xml).not.toContain('SECTION 23 09 23');
  });

  it('explicit request base wins over the stored base', async () => {
    const res = await json('POST', `/revisions/${addendumRevisionId}/generate`, {
      baseRevisionId: addendumRevisionId,
    });
    // Comparing the addendum against itself has no changed sections. If the
    // stored base incorrectly won, this would render the painting addendum.
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'addendum has no changed sections' });
  });

  // Regression (ADR-033 / Codex P2): the article-role deriver added meta.articleRole
  // to article nodes in buildNodeTree. A base revision frozen BEFORE that change has
  // no articleRole key in its snapshot JSON, so comparing it against a target frozen
  // AFTER must NOT flag otherwise-identical sections as changed. The fingerprint must
  // strip the derived field. Here we simulate the pre-change base by stripping
  // articleRole from the stored base snapshot, then re-run addendum diffing.
  it('addendum: a derived articleRole added since the base snapshot does not flag unchanged sections', async () => {
    // The 'SUMMARY' article in every fixture tree now carries articleRole='summary'
    // in fresh snapshots. Strip it from the base revision's stored trees to mimic a
    // snapshot frozen before the deriver existed.
    const baseSnaps = await pool.query<{ spec_id: string; tree: SpecTree }>(
      `SELECT spec_id, tree FROM package_revision_specs WHERE revision_id = $1`,
      [baseRevisionId]
    );
    const stripRole = (nodes: readonly SpecNode[]): SpecNode[] =>
      nodes.map((n) => {
        const meta = { ...n.meta };
        delete (meta as { articleRole?: unknown }).articleRole;
        return { ...n, meta, children: stripRole(n.children) };
      });
    let strippedAny = false;
    for (const snap of baseSnaps.rows) {
      const before = JSON.stringify(snap.tree);
      const legacy = { ...snap.tree, parts: stripRole(snap.tree.parts) };
      if (JSON.stringify(legacy) !== before) strippedAny = true;
      await pool.query(
        `UPDATE package_revision_specs SET tree = $1::jsonb WHERE revision_id = $2 AND spec_id = $3`,
        [JSON.stringify(legacy), baseRevisionId, snap.spec_id]
      );
    }
    // Guard: the fixture must actually contain a role-bearing article, else the test
    // would pass vacuously and never exercise the regression.
    expect(strippedAny).toBe(true);

    const res = await json('POST', `/revisions/${addendumRevisionId}/generate`, {
      baseRevisionId,
    });
    expect(res.status).toBe(200);
    const xml = await getDocXml(Buffer.from(await res.arrayBuffer()));
    // Only the genuinely-edited painting section is affected — the unchanged
    // concrete/controls sections must NOT reappear just because their base snapshot
    // lacks the derived articleRole the target now has.
    expect(xml).toContain('09 91 00 - Painting');
    expect(xml).not.toContain('SECTION 03 30 00');
    expect(xml).not.toContain('SECTION 23 09 23');
  });
});

// ADR-079 (#406) decision 15: an addendum's readiness gate covers
// `changedSpecs` ONLY — a spec carried over unchanged from the base revision
// was already evaluated (or issued) at that prior point. This describe block
// is its own isolated project/package/revision chain (never touching the
// shared base/addendum fixture above) so the note-carrying fixture spec can't
// perturb any of that describe block's exact-XML assertions.
describe('POST /revisions/:id/generate — issuance-readiness gate (ADR-079, #406)', () => {
  let gateProjectId: string;
  let unchangedNoteSpecId: string; // carries the blocking note; never in changedSpecs
  let changedSpecId: string;
  let gatePackageId: string;
  let gateBaseRevisionId: string;
  let gateAddendumRevisionId: string;

  beforeAll(async () => {
    await insertMasterWithTree(
      '26 05 19',
      'Low-Voltage Wire — Gate Fixture',
      'Confirm conductor gauge with owner.',
      'note'
    );
    await insertMasterWithTree(
      '09 91 26',
      'Exterior Painting — Gate Fixture',
      'Original gate painting text.'
    );

    const created = await json('POST', '/projects', {
      name: `Readiness Gate Revision Render P1 ${Date.now()}`,
      sourceLibraryIds: [companyId],
    });
    gateProjectId = (await data(created))['projectId'] as string;
    projectIds.push(gateProjectId);

    async function addGateSection(section: string): Promise<string> {
      const res = await json('POST', `/projects/${gateProjectId}/specs`, { section });
      return (await data(res))['specId'] as string;
    }
    unchangedNoteSpecId = await addGateSection('26 05 19');
    changedSpecId = await addGateSection('09 91 26');

    const pkg = await json('POST', `/projects/${gateProjectId}/packages`, { name: 'Gate CD Set' });
    gatePackageId = (await data(pkg))['packageId'] as string;
    const membership = await json('PUT', `/packages/${gatePackageId}/specs`, {
      specIds: [unchangedNoteSpecId, changedSpecId],
    });
    if (membership.status !== 200) throw new Error('failed to set gate package membership');

    // mode omitted (INV-1) — the note-carrying spec must never block package
    // issuance itself; this describe block is only about the generate-time gate.
    const base = await json('POST', `/packages/${gatePackageId}/revisions`, {
      label: 'Gate 100% CD',
    });
    gateBaseRevisionId = (await data(base))['revisionId'] as string;

    await pool.query(
      `UPDATE paragraphs SET text = 'Changed gate painting text for addendum.'
       WHERE spec_id = $1 AND node_type = 'pr1'`,
      [changedSpecId]
    );

    const addendum = await json('POST', `/packages/${gatePackageId}/revisions`, {
      type: 'addendum',
      attributes: { number: 1 },
      baseRevisionId: gateBaseRevisionId,
    });
    gateAddendumRevisionId = (await data(addendum))['revisionId'] as string;
  });

  it(
    'addendum readiness gate covers changed specs only — an outstanding note on the ' +
      'unchanged base-only spec never blocks final generation — INV-12',
    async () => {
      const res = await json('POST', `/revisions/${gateAddendumRevisionId}/generate`, {
        baseRevisionId: gateBaseRevisionId,
        mode: 'final',
      });
      // unchangedNoteSpecId (26 05 19) carries the blocking note but is NOT
      // part of changedSpecs (only the painting text edit is) — the gate
      // must never see it.
      expect(res.status).toBe(200);
    }
  );

  it('contrast: the full (non-addendum) revision gates every member spec, including the unchanged one — INV-4', async () => {
    const res = await json('POST', `/revisions/${gateBaseRevisionId}/generate`, {
      mode: 'final',
    });
    // The base/full revision has no "changed" concept — every member spec
    // (including the note-carrying one) is in scope, unlike the addendum
    // case above.
    expect(res.status).toBe(422);
  });
});
