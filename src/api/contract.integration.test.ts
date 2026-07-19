import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import {
  assertResponse,
  expressRouteManifest,
  specOperationManifest,
  successJsonOps,
  loadSpec,
} from '../test-utils/contract/validate-response.js';
import { pool, createLibrary } from '../db/index.js';

// MCP is registered separately (not on `router`); exclude defensively.
const EXCLUDE = new Set(['post /mcp', 'get /mcp', 'delete /mcp']);

// Response bodies asserted in this file.
const RESPONSE_COVERED = new Set([
  'delete /projects/{}/revision-nomenclature',
  'delete /specs/{}',
  'get /health',
  'get /conventions',
  'get /disciplines',
  'get /libraries',
  'get /libraries/{}/specs',
  'get /projects',
  'get /projects/{}/revision-nomenclature',
  'get /projects/{}/specs',
  'get /revision-nomenclature-profiles',
  'get /search',
  'get /templates',
  'put /libraries/{}/disciplines',
  'delete /libraries/{}/disciplines',
  'post /specs/{}/restore',
  'post /projects/{}/revision-nomenclature/clone',
  'put /projects/{}/revision-nomenclature',
  // header/footer config CRUD + resolve (#476, ADR-040)
  'get /libraries/{}/header-footer',
  'put /libraries/{}/header-footer',
  'delete /libraries/{}/header-footer',
  'get /projects/{}/header-footer',
  'put /projects/{}/header-footer',
  'delete /projects/{}/header-footer',
  'get /packages/{}/header-footer',
  'put /packages/{}/header-footer',
  'delete /packages/{}/header-footer',
  'get /revisions/{}/header-footer',
  'put /revisions/{}/header-footer',
  'delete /revisions/{}/header-footer',
  'get /projects/{}/header-footer/resolved',
  'get /packages/{}/header-footer/resolved',
  'get /revisions/{}/header-footer/resolved',
]);

// Documented JSON ops not yet response-verified (burned down in PR2…N).
const RESPONSE_ALLOWLIST = new Set([
  'delete /packages/{}',
  'delete /projects/{}/specs/{}',
  'delete /specs/{}/lock',
  'delete /specs/{}/style-source',
  'get /libraries/{}/conventions',
  'get /libraries/{}/divisions/{}/general-spec',
  'get /libraries/import/jobs/{}',
  'post /libraries/{}/import',
  'get /parse/jobs/{}',
  'get /projects/{}',
  'get /projects/{}/divisions/{}/general-spec',
  'get /packages/{}/revisions',
  'get /projects/{}/packages',
  'get /projects/{}/references/broken',
  'get /projects/{}/references/inbound',
  'get /projects/{}/specs/{}/references',
  'get /revisions/{}',
  'get /specs/{}',
  'get /specs/{}/hierarchy-report',
  'get /specs/{}/lineage',
  'get /specs/{}/lock',
  'get /templates/{}',
  'patch /libraries/{}',
  'patch /specs/{}',
  'patch /specs/{}/paragraphs/{}',
  'patch /specs/{}/paragraphs/{}/removal',
  'post /specs/{}/paragraphs',
  'patch /templates/{}',
  'post /clients',
  'get /clients',
  'get /clients/{}',
  'patch /clients/{}',
  'post /users',
  'get /users',
  'get /users/{}',
  'post /libraries/clients',
  'post /libraries/{}/conventions/clone',
  'post /packages/{}/revisions',
  'post /parse',
  'post /projects',
  'post /projects/{}/packages',
  'post /projects/{}/specs',
  'post /specs/{}/diff',
  'post /specs/{}/merge',
  'post /specs/{}/style-source',
  'post /templates',
  'post /templates/import',
  'post /templates/{}/rules',
  'put /libraries/{}/conventions',
  'put /libraries/{}/divisions/{}/general-spec',
  'put /packages/{}/specs',
  'put /projects/{}/divisions/{}/general-spec',
  'put /projects/{}/sources',
  'put /specs/{}/lock',
  'get /projects/{}/required-sections',
  'put /projects/{}/required-sections',
  'get /projects/{}/packages/{}/required-sections',
  'put /projects/{}/packages/{}/required-sections',
  'get /projects/{}/coordination-report',
  'get /projects/{}/reference-graph',
  'get /libraries/{}/reference-graph',
  'get /projects/{}/standards',
  'get /libraries/{}/standards',
  'put /standards/{}/{}',
  'get /projects/{}/revit-links',
  'post /reports/compare',
  'post /projects/{}/submittal-register',
  'get /specs/{}/open-comments',
  'get /projects/{}/open-comments',
  'patch /specs/{}/paragraphs/{}/editability',
  'post /specs/{}/reclassify',
  'post /specs/{}/finalize',
  'post /specs/{}/reopen',
  'post /specs/{}/paragraphs/{}/comments/{}/accept-as-note',
  'get /specs/{}/paragraphs/{}/associations',
  'post /specs/{}/paragraphs/{}/associations',
  'patch /projects/{}',
  'delete /projects/{}',
  'post /projects/{}/restore',
  // numbering profiles (#299)
  'get /libraries/{}/numbering-profiles',
  'post /libraries/{}/numbering-profiles',
  'post /numbering-profiles/snapshot',
  'get /numbering-profiles/{}',
  'patch /numbering-profiles/{}',
  'put /specs/{}/numbering-profile',
]);

interface HeaderFooterFixture {
  readonly libraryId: string;
  readonly projectId: string;
  readonly packageId: string;
  readonly revisionId: string;
}

// One anchor per scope kind (client library, project, design package, issued
// revision) so the response-contract tests below can round-trip a real config
// row at every level the header/footer surface supports (#476, ADR-040).
async function createHeaderFooterFixture(): Promise<HeaderFooterFixture> {
  const library = await createLibrary({
    tier: 'client',
    name: `contract-header-footer-client-${Date.now()}`,
  });
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`contract-header-footer-project-${Date.now()}`]
  );
  const projectRow = project.rows[0];
  if (!projectRow) throw new Error('failed to create contract header/footer project');
  const pkg = await pool.query<{ id: string }>(
    `INSERT INTO design_packages (project_id, name, position) VALUES ($1, $2, 1) RETURNING id`,
    [projectRow.id, `contract-header-footer-package-${Date.now()}`]
  );
  const packageRow = pkg.rows[0];
  if (!packageRow) throw new Error('failed to create contract header/footer package');
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO package_revisions
       (package_id, label, revision_type, revision_date, sort_order, attributes)
     VALUES ($1, 'Addendum 1', 'addendum', '2026-06-18'::date, 1, '{}'::jsonb)
     RETURNING id`,
    [packageRow.id]
  );
  const revisionRow = revision.rows[0];
  if (!revisionRow) throw new Error('failed to create contract header/footer revision');
  return {
    libraryId: library.id,
    projectId: projectRow.id,
    packageId: packageRow.id,
    revisionId: revisionRow.id,
  };
}

async function deleteHeaderFooterFixture(fixture: HeaderFooterFixture): Promise<void> {
  await pool.query('DELETE FROM header_footer_configs');
  await pool.query('DELETE FROM package_revisions WHERE id = $1', [fixture.revisionId]);
  await pool.query('DELETE FROM design_packages WHERE id = $1', [fixture.packageId]);
  await pool.query('DELETE FROM projects WHERE id = $1', [fixture.projectId]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [fixture.libraryId]);
}

let server: Server;
let baseUrl: string;
let projectId: string;
let disciplineLibraryId: string;
let headerFooterFixture: HeaderFooterFixture;

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
  const project = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`contract-revision-nomenclature-${Date.now()}`]
  );
  const row = project.rows[0];
  if (!row) throw new Error('failed to create contract project');
  projectId = row.id;
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('client', $1) RETURNING id`,
    [`contract-disciplines-${Date.now()}`]
  );
  const libRow = lib.rows[0];
  if (!libRow) throw new Error('failed to create contract discipline library');
  disciplineLibraryId = libRow.id;
  headerFooterFixture = await createHeaderFooterFixture();
});

afterAll(async () => {
  if (disciplineLibraryId) {
    await pool.query('DELETE FROM discipline_section_rules WHERE library_id = $1', [
      disciplineLibraryId,
    ]);
    await pool.query('DELETE FROM libraries WHERE id = $1', [disciplineLibraryId]);
  }
  if (projectId) await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  if (headerFooterFixture) await deleteHeaderFooterFixture(headerFooterFixture);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('openapi structural coverage (route <-> spec, both directions)', () => {
  it('every Express route is documented and every documented op is implemented', async () => {
    const doc = await loadSpec();
    const exp = new Set(expressRouteManifest(router));
    const spec = new Set(specOperationManifest(doc));
    const undocumented = [...exp]
      .filter((o) => !spec.has(o) && !EXCLUDE.has(o))
      .sort((a, b) => a.localeCompare(b));
    const unimplemented = [...spec]
      .filter((o) => !exp.has(o) && !EXCLUDE.has(o))
      .sort((a, b) => a.localeCompare(b));
    expect(undocumented, 'Express routes missing from openapi.yaml').toEqual([]);
    expect(unimplemented, 'openapi.yaml operations with no Express route').toEqual([]);
  });

  it('every success-JSON operation is response-covered or explicitly allowlisted', async () => {
    const doc = await loadSpec();
    const uncovered = successJsonOps(doc).filter(
      (o) => !RESPONSE_COVERED.has(o) && !RESPONSE_ALLOWLIST.has(o) && !EXCLUDE.has(o)
    );
    expect(uncovered, 'JSON ops needing a response assertion or allowlist entry').toEqual([]);
  });
});

describe('response contract (covered endpoints)', () => {
  it('GET /health matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/health', 200, await res.json());
  });

  it('GET /conventions matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/conventions`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/conventions', 200, await res.json());
  });

  it('GET /templates matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/templates`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/templates', 200, await res.json());
  });

  it('revision nomenclature endpoints match their documented 2xx schemas', async () => {
    const list = await fetch(`${baseUrl}/revision-nomenclature-profiles`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as unknown;
    await assertResponse('get', '/revision-nomenclature-profiles', 200, listBody);

    const sourceId = (listBody as { data: readonly { id: string }[] }).data[0]?.id;
    if (!sourceId) throw new Error('revision nomenclature built-in missing');
    const get = await fetch(`${baseUrl}/projects/${projectId}/revision-nomenclature`);
    expect(get.status).toBe(200);
    await assertResponse('get', '/projects/{id}/revision-nomenclature', 200, await get.json());

    const put = await fetch(`${baseUrl}/projects/${projectId}/revision-nomenclature`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Contract', types: [{ key: 'addendum' }] }),
    });
    expect(put.status).toBe(200);
    await assertResponse('put', '/projects/{id}/revision-nomenclature', 200, await put.json());

    const clone = await fetch(`${baseUrl}/projects/${projectId}/revision-nomenclature/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId }),
    });
    expect(clone.status).toBe(201);
    await assertResponse(
      'post',
      '/projects/{id}/revision-nomenclature/clone',
      201,
      await clone.json()
    );

    const del = await fetch(`${baseUrl}/projects/${projectId}/revision-nomenclature`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await assertResponse('delete', '/projects/{id}/revision-nomenclature', 200, await del.json());
  });

  it('library read endpoints match their documented 200 schemas', async () => {
    const list = await fetch(`${baseUrl}/libraries`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as unknown;
    await assertResponse('get', '/libraries', 200, listBody);

    const libraryId = (listBody as { data: readonly { id: string }[] }).data[0]?.id;
    if (!libraryId) throw new Error('no seeded library to read specs from');
    const specs = await fetch(`${baseUrl}/libraries/${libraryId}/specs`);
    expect(specs.status).toBe(200);
    await assertResponse('get', '/libraries/{id}/specs', 200, await specs.json());
  });

  it('GET /projects matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/projects`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/projects', 200, await res.json());
  });

  it('GET /search matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/search?q=firestopping`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/search', 200, await res.json());
  });

  it('discipline endpoints match their documented schemas', async () => {
    // Built-in default catalog.
    const list = await fetch(`${baseUrl}/disciplines`);
    expect(list.status).toBe(200);
    await assertResponse('get', '/disciplines', 200, await list.json());

    // Replace a library's rule set, then clear it.
    const put = await fetch(`${baseUrl}/libraries/${disciplineLibraryId}/disciplines`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rules: [{ discipline: 'mechanical', divisionStart: '21', divisionEnd: '23' }],
      }),
    });
    expect(put.status).toBe(200);
    await assertResponse('put', '/libraries/{id}/disciplines', 200, await put.json());

    const del = await fetch(`${baseUrl}/libraries/${disciplineLibraryId}/disciplines`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await assertResponse('delete', '/libraries/{id}/disciplines', 200, await del.json());
  });

  it('GET /projects/{id}/specs matches its documented 200 schema', async () => {
    const res = await fetch(`${baseUrl}/projects/${projectId}/specs`);
    expect(res.status).toBe(200);
    await assertResponse('get', '/projects/{id}/specs', 200, await res.json());
  });
});

describe('header/footer config CRUD + resolve endpoints (#476, ADR-040)', () => {
  // `left` carries a `kind: 'image'` field (#308, ADR-069) so every PUT/GET/
  // resolve round trip in this suite also proves the openapi.yaml
  // `&headerFooterCell` anchor and the Zod `HeaderFooterFieldSchema` agree on
  // the image fields — not just the pre-existing text-field kinds.
  const SAMPLE_CONFIG = {
    header: {
      center: { content: [{ kind: 'projectName' }] },
      left: {
        content: [
          {
            kind: 'image',
            imageData: 'AAAA',
            imageMediaType: 'image/png',
            widthEmu: 914400,
            heightEmu: 914400,
            altText: 'Company logo',
          },
        ],
      },
    },
    footer: { right: { content: [{ kind: 'pageNumber' }] } },
  };

  interface HeaderFooterScopeCase {
    readonly urlBase: string;
    readonly pathTemplate: string;
    readonly responseIdField: 'libraryId' | 'projectId' | 'packageId' | 'revisionId';
    readonly id: () => string;
  }

  // One case per scope kind — the only real difference between them is which
  // anchor id/response field they key on, so a table keeps the four CRUD
  // round trips from becoming four near-identical `it` blocks.
  const scopeCases: readonly HeaderFooterScopeCase[] = [
    {
      urlBase: '/libraries',
      pathTemplate: '/libraries/{id}/header-footer',
      responseIdField: 'libraryId',
      id: () => headerFooterFixture.libraryId,
    },
    {
      urlBase: '/projects',
      pathTemplate: '/projects/{id}/header-footer',
      responseIdField: 'projectId',
      id: () => headerFooterFixture.projectId,
    },
    {
      urlBase: '/packages',
      pathTemplate: '/packages/{id}/header-footer',
      responseIdField: 'packageId',
      id: () => headerFooterFixture.packageId,
    },
    {
      urlBase: '/revisions',
      pathTemplate: '/revisions/{id}/header-footer',
      responseIdField: 'revisionId',
      id: () => headerFooterFixture.revisionId,
    },
  ];

  it.each(scopeCases)(
    '$urlBase/{id}/header-footer PUT/GET/DELETE match their documented 200 schemas',
    async (scopeCase) => {
      const id = scopeCase.id();
      const url = `${baseUrl}${scopeCase.urlBase}/${id}/header-footer`;

      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE_CONFIG),
      });
      expect(put.status).toBe(200);
      await assertResponse('put', scopeCase.pathTemplate, 200, await put.json());

      const get = await fetch(url);
      expect(get.status).toBe(200);
      await assertResponse('get', scopeCase.pathTemplate, 200, await get.json());

      const del = await fetch(url, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const delBody = (await del.json()) as { data: Record<string, string> };
      expect(delBody.data[scopeCase.responseIdField]).toBe(id);
      await assertResponse('delete', scopeCase.pathTemplate, 200, delBody);
    }
  );

  it('resolve endpoints match their documented 200 schemas at every anchor level', async () => {
    const {
      projectId: hfProjectId,
      packageId: hfPackageId,
      revisionId: hfRevisionId,
    } = headerFooterFixture;
    const anchors: readonly [string, string][] = [
      [`/projects/${hfProjectId}`, '/projects/{id}/header-footer/resolved'],
      [`/packages/${hfPackageId}`, '/packages/{id}/header-footer/resolved'],
      [`/revisions/${hfRevisionId}`, '/revisions/{id}/header-footer/resolved'],
    ];

    // Seed an override at each anchor so `layers` in the resolved response is
    // non-empty — proving the schema holds for a real merged config, not just
    // the degenerate empty-layers case.
    for (const [urlBase] of anchors) {
      const put = await fetch(`${baseUrl}${urlBase}/header-footer`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(SAMPLE_CONFIG),
      });
      expect(put.status).toBe(200);
    }

    for (const [urlBase, pathTemplate] of anchors) {
      const resolved = await fetch(`${baseUrl}${urlBase}/header-footer/resolved`);
      expect(resolved.status).toBe(200);
      await assertResponse('get', pathTemplate, 200, await resolved.json());
    }
  });
});
