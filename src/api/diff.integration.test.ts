import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import JSZip from 'jszip';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSpec, insertTree, pool } from '../db/index.js';
import type { DiffResult } from '../merge/index.js';
import { registerMcpRoutes } from '../mcp/server.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import type { ObjectBlobNode, ObjectMeta } from '../ast/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ORIGINAL_TEXT = 'Install listed copper cabling.';
const REVISED_TEXT = 'Install revised copper cabling.';

let server: Server;
let baseUrl: string;
let specId: string;
let partId: string;
let articleId: string;
let paragraphId: string;

interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

async function mcpCall(
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const line = text.split('\n').find((entry) => entry.startsWith('data: '));
    return JSON.parse(line?.slice(6) ?? '{}') as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function fetchGeneratedDocx(): Promise<Buffer> {
  const res = await fetch(`${baseUrl}/specs/${specId}/generate`, { method: 'POST' });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function postDiff(
  buffer: Buffer,
  filename = 'returned.docx'
): Promise<{
  readonly status: number;
  readonly body: ApiResponse<DiffResult>;
}> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), filename);
  const res = await fetch(`${baseUrl}/specs/${specId}/diff`, { method: 'POST', body: form });
  return { status: res.status, body: (await res.json()) as ApiResponse<DiffResult> };
}

async function updateDocumentXml(buffer: Buffer, edit: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  zip.file('word/document.xml', edit(await file.async('string')));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function replaceParagraphText(xml: string): string {
  if (!xml.includes(ORIGINAL_TEXT)) throw new Error('expected paragraph text missing');
  return xml.replace(ORIGINAL_TEXT, REVISED_TEXT);
}

/**
 * #525: simulate an editor deleting a whole table in Word — strip the entire
 * `w:tbl` element carrying `anchorUuid`, so NONE of the object's interior
 * anchors survive anywhere in the returned DOCX. Matches the exact `<w:tbl>`
 * open tag (never the `<w:tblPr>`/`<w:tblGrid>` children that sit between it
 * and the anchor) and throws loudly if either bound is missing, so a
 * generator change that adds attributes fails the test instead of silently
 * mis-stripping.
 */
function removeTableContaining(anchorUuid: string): (xml: string) => string {
  return (xml) => {
    const tagIndex = xml.indexOf(`specr-uuid-${anchorUuid}`);
    if (tagIndex === -1) throw new Error('expected object anchor tag missing');
    const start = xml.lastIndexOf('<w:tbl>', tagIndex);
    const end = xml.indexOf('</w:tbl>', tagIndex);
    if (start === -1 || end === -1) throw new Error('table bounds missing');
    return xml.slice(0, start) + xml.slice(end + '</w:tbl>'.length);
  };
}

function removeContentControl(xml: string): string {
  const tagIndex = xml.indexOf(`specr-uuid-${paragraphId}`);
  if (tagIndex === -1) throw new Error('expected content-control tag missing');
  const start = xml.lastIndexOf('<w:sdt>', tagIndex);
  const end = xml.indexOf('</w:sdt>', tagIndex);
  if (start === -1 || end === -1) throw new Error('content control bounds missing');
  return xml.slice(0, start) + xml.slice(end + '</w:sdt>'.length);
}

beforeAll(async () => {
  const app = express();
  const restJson = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/mcp')) return next();
    restJson(req, res, next);
  });
  app.use(router);
  registerMcpRoutes(app, { rateLimitMax: 1000 });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;

  partId = randomUUID();
  articleId = randomUUID();
  paragraphId = randomUUID();
  specId = await createSpec({
    section: '27 15 00',
    title: 'Diff Integration Spec',
    source: `d35_${randomUUID().slice(0, 8)}`,
  });
  await insertTree(
    {
      id: specId,
      section: '27 15 00',
      title: 'Diff Integration Spec',
      parts: [
        {
          id: partId,
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: articleId,
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                {
                  id: paragraphId,
                  type: 'pr1',
                  text: ORIGINAL_TEXT,
                  meta: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /specs/:id/diff (integration)', () => {
  it('unmodified generated DOCX returns no added, modified, deleted, or conflicts', async () => {
    const { status, body } = await postDiff(await fetchGeneratedDocx());

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
  });

  it('changed paragraph text returns modified diff with uuid, base, theirs, and ours', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), replaceParagraphText);
    const { status, body } = await postDiff(edited);

    expect(status).toBe(200);
    expect(body.data?.modified).toEqual([
      { uuid: paragraphId, base: ORIGINAL_TEXT, theirs: REVISED_TEXT, ours: ORIGINAL_TEXT },
    ]);
    expect(body.data?.deleted).toEqual([]);
    expect(body.data?.conflicts).toEqual([]);
  });

  it('deleted content-control paragraph returns deleted UUID', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), removeContentControl);
    const { status, body } = await postDiff(edited);

    expect(status).toBe(200);
    expect(body.data?.deleted).toEqual([paragraphId]);
    expect(body.data?.modified).toEqual([]);
  });

  it('non-DOCX uploads return 422', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not a docx'], { type: 'text/plain' }), 'bad.txt');
    const res = await fetch(`${baseUrl}/specs/${specId}/diff`, { method: 'POST', body: form });
    const body = (await res.json()) as ApiResponse<never>;

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.error).toContain('DOCX');
  });
});

describe('soft-removal is not a hard deletion in the diff (#251/#276)', () => {
  async function setRemoved(removed: boolean): Promise<void> {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${paragraphId}/removal`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removed }),
    });
    expect(res.status).toBe(200);
  }

  // Remove a paragraph via the /removal endpoint, then diff the freshly generated
  // DOCX. The generator omits the vanished node, and the merge snapshots now omit
  // it too — so it must NOT surface in diff.deleted (that was the false-hard-delete
  // bug). Restore afterward so sibling tests see the original tree.
  it('a removed paragraph does NOT appear in diff.deleted', async () => {
    await setRemoved(true);
    try {
      const { status, body } = await postDiff(await fetchGeneratedDocx());
      expect(status).toBe(200);
      expect(body.data?.deleted).not.toContain(paragraphId);
      expect(body.data?.deleted).toEqual([]);
      expect(body.data?.added).toEqual([]);
      expect(body.data?.modified).toEqual([]);
    } finally {
      await setRemoved(false); // restore for other tests
    }
  });
});

describe('tool: get_spec_diff', () => {
  it('returns the same DiffResult shape as REST for an edited DOCX', async () => {
    const edited = await updateDocumentXml(await fetchGeneratedDocx(), replaceParagraphText);
    const rest = await postDiff(edited);
    const rpc = await mcpCall('tools/call', {
      name: 'get_spec_diff',
      arguments: { specId, contentBase64: edited.toString('base64') },
    });
    const result = rpc['result'] as Record<string, unknown>;
    const content = result['content'] as { type: string; text: string }[];
    const mcp = JSON.parse(content[0]?.text ?? '{}') as DiffResult;

    expect(result['isError']).toBeUndefined();
    expect(mcp).toEqual(rest.body.data);
  });
});

describe('resource: specr://specs/{id}/diff', () => {
  it('returns JSON DiffResult for the generated current DOCX', async () => {
    const rpc = await mcpCall('resources/read', { uri: `specr://specs/${specId}/diff` });
    const result = rpc['result'] as Record<string, unknown>;
    const contents = result['contents'] as { mimeType: string; text: string }[];
    const diff = JSON.parse(contents[0]?.text ?? '{}') as DiffResult;

    expect(contents[0]?.mimeType).toBe('application/json');
    expect(diff).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
  });
});

// #520 review finding: computeSpecDiff's real wiring (DB → generateDocx →
// extractContentControls → getObjectStructuralSnapshots → computeDiff) was
// only ever exercised at the computeDiff unit level with hand-built
// ObjectStructuralSnapshot/ExtractResult fixtures (merge/diff.test.ts) — no
// test here or in merge.integration.test.ts ever created a node_type='object'
// row. A wiring bug (e.g. an objectId/interiorUuids casing mismatch between
// getObjectStructuralSnapshots and extractObjectBlocks, or the generator's own
// emitted blob not fingerprint-matching itself) would pass every existing
// test while silently reintroducing "an object row reads as a hard delete".
function anchoredTableMeta(anchorUuid: string, text: string): ObjectMeta {
  const anchoredCell: ObjectBlobNode = {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `specr-uuid-${anchorUuid}` } }] },
      { 'w:sdtContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }] },
    ],
  } as ObjectBlobNode;
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    blob: [{ 'w:tbl': [{ 'w:tr': [{ 'w:tc': [anchoredCell] }] }] }],
  };
}

/**
 * #648: a table cell mixing one hidden (w:vanish) run and one visible run.
 * `visibleText` matches ONLY the visible run — the object tier's AST
 * (objectText, via parser/docx/body-objects.ts's collectText) already drops
 * hidden runs (#641/ADR-092), so this is what a correctly round-tripped
 * capture must store. Before the #648 fix, merge/extract.ts's visibleText
 * had no vanish handling at all and would concatenate the hidden run's text
 * in front of the visible one, diverging from this AST snapshot and reading
 * an untouched round-tripped DOCX as modified.
 */
function anchoredMixedVisibilityTableMeta(
  anchorUuid: string,
  hiddenText: string,
  visibleRunText: string
): ObjectMeta {
  const anchoredCell: ObjectBlobNode = {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `specr-uuid-${anchorUuid}` } }] },
      {
        'w:sdtContent': [
          {
            'w:p': [
              {
                'w:r': [{ 'w:rPr': [{ 'w:vanish': [] }] }, { 'w:t': [{ '#text': hiddenText }] }],
              },
              { 'w:r': [{ 'w:t': [{ '#text': visibleRunText }] }] },
            ],
          },
        ],
      },
    ],
  } as ObjectBlobNode;
  return {
    kind: 'table',
    floating: false,
    generation: 'drawingml',
    rows: 1,
    columns: 1,
    blob: [{ 'w:tbl': [{ 'w:tr': [{ 'w:tc': [anchoredCell] }] }] }],
  };
}

describe('body-level object round-trip — real wiring (#520 review finding)', () => {
  const OBJ_PART_ID = randomUUID();
  const OBJ_OBJECT_ID = randomUUID();
  const OBJ_TEXT_ID = randomUUID();
  const OBJ_CELL_TEXT = 'Captured cell text.';
  let objSpecId: string;

  beforeAll(async () => {
    objSpecId = await createSpec({
      section: '09 91 26',
      title: 'Object Diff Wiring Spec',
      source: `d520diff_${randomUUID().slice(0, 8)}`,
    });
    await insertTree(
      {
        id: objSpecId,
        section: '09 91 26',
        title: 'Object Diff Wiring Spec',
        parts: [
          {
            id: OBJ_PART_ID,
            type: 'part',
            text: 'GENERAL',
            meta: {},
            children: [
              {
                id: OBJ_OBJECT_ID,
                type: 'object',
                text: '',
                meta: { object: anchoredTableMeta(OBJ_TEXT_ID, OBJ_CELL_TEXT) },
                children: [
                  {
                    id: OBJ_TEXT_ID,
                    type: 'objectText',
                    text: OBJ_CELL_TEXT,
                    meta: {},
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      objSpecId,
      pool
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [objSpecId]);
  });

  it(
    'an unmodified generated DOCX round-trips through DB → generateDocx → ' +
      'extractContentControls → getObjectStructuralSnapshots → computeDiff with an empty ' +
      'diff — the object row itself never reads as a hard delete and its anchored interior ' +
      'text never reads as modified',
    async () => {
      const generateRes = await fetch(`${baseUrl}/specs/${objSpecId}/generate`, { method: 'POST' });
      expect(generateRes.status).toBe(200);
      const buffer = Buffer.from(await generateRes.arrayBuffer());

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }), 'object.docx');
      const diffRes = await fetch(`${baseUrl}/specs/${objSpecId}/diff`, {
        method: 'POST',
        body: form,
      });
      const body = (await diffRes.json()) as ApiResponse<DiffResult>;

      expect(diffRes.status).toBe(200);
      expect(body.data).toEqual({
        added: [],
        modified: [],
        deleted: [],
        conflicts: [],
        objectConflicts: [],
        warnings: [],
      });
    }
  );

  // #525 adversarial-review finding: the whole-object-delete detection added
  // in this PR was only ever exercised at the computeDiff unit level
  // (merge/diff.test.ts) and, for the accept-rejection posture, against a
  // hand-built ObjectConflictDiff (merge/conflict.integration.test.ts) —
  // neither runs the real DB → generateDocx → extractContentControls →
  // getObjectStructuralSnapshots → computeDiff wiring, nor the optional-
  // `theirs` DiffResultSchema serialization at the API boundary. A regression
  // in any of those would silently reinstate the original corruption (the
  // deleted table reappears, the delete misreported as child paragraph
  // deletions) while every other added test still passed.
  it(
    'deleting the whole table in Word surfaces as ONE atomic objectConflict with `theirs` ' +
      'absent — never as per-child paragraph deletions (#525)',
    async () => {
      const generateRes = await fetch(`${baseUrl}/specs/${objSpecId}/generate`, { method: 'POST' });
      expect(generateRes.status).toBe(200);
      const buffer = Buffer.from(await generateRes.arrayBuffer());
      const edited = await updateDocumentXml(buffer, removeTableContaining(OBJ_TEXT_ID));

      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(edited)], { type: DOCX_MIME }),
        'object-deleted.docx'
      );
      const diffRes = await fetch(`${baseUrl}/specs/${objSpecId}/diff`, {
        method: 'POST',
        body: form,
      });
      const body = (await diffRes.json()) as ApiResponse<DiffResult>;

      expect(diffRes.status).toBe(200);
      const diff = body.data;
      expect(diff).toBeDefined();
      if (!diff) return;

      expect(diff.objectConflicts).toHaveLength(1);
      const [conflict] = diff.objectConflicts;
      expect(conflict).toBeDefined();
      if (!conflict) return;

      expect(conflict.objectId).toBe(OBJ_OBJECT_ID);
      expect(conflict.affectedUuids).toEqual([OBJ_TEXT_ID]);
      expect(conflict.base).toMatchObject({ kind: 'table', rows: 1, columns: 1 });
      // the object itself is gone from theirs, so there is nothing to
      // fingerprint — `theirs` must be ABSENT, not present-and-undefined
      // (ADR-089; `.exactOptional()` in ast/merge-schemas.ts)
      expect('theirs' in conflict).toBe(false);

      // the whole point of #525: the delete is reported once, atomically —
      // the object's interior anchor never leaks into per-child noise
      expect(diff.deleted).toEqual([]);
      expect(diff.modified).toEqual([]);
      expect(diff.conflicts).toEqual([]);
      expect(diff.added).toEqual([]);
    }
  );
});

// #648: an object-interior table cell mixing a hidden and a visible run.
// Before the fix, merge/extract.ts's visibleText had no w:vanish handling at
// all, so it disagreed with the AST (objectText, which already drops hidden
// runs — #641/ADR-092): an untouched round-tripped DOCX with this shape would
// report as modified. Proved at the real wiring — DB → generateDocx →
// extractContentControls → getObjectStructuralSnapshots → computeDiff — not
// just at the unit level, since that is where the two code paths' divergence
// actually surfaces as a false diff entry.
describe('body-level object round-trip — hidden/visible run mix (#648)', () => {
  const VAN_PART_ID = randomUUID();
  const VAN_OBJECT_ID = randomUUID();
  const VAN_TEXT_ID = randomUUID();
  const VAN_HIDDEN_TEXT = 'Hidden internal guidance. ';
  const VAN_VISIBLE_TEXT = 'Visible spec cell text.';
  let vanSpecId: string;

  beforeAll(async () => {
    vanSpecId = await createSpec({
      section: '09 91 26',
      title: 'Object Vanish Diff Wiring Spec',
      source: `d648diff_${randomUUID().slice(0, 8)}`,
    });
    await insertTree(
      {
        id: vanSpecId,
        section: '09 91 26',
        title: 'Object Vanish Diff Wiring Spec',
        parts: [
          {
            id: VAN_PART_ID,
            type: 'part',
            text: 'GENERAL',
            meta: {},
            children: [
              {
                id: VAN_OBJECT_ID,
                type: 'object',
                text: '',
                meta: {
                  object: anchoredMixedVisibilityTableMeta(
                    VAN_TEXT_ID,
                    VAN_HIDDEN_TEXT,
                    VAN_VISIBLE_TEXT
                  ),
                },
                children: [
                  {
                    id: VAN_TEXT_ID,
                    type: 'objectText',
                    // Matches the object tier's AST (visible run only) —
                    // never the hidden run's text (#641/ADR-092).
                    text: VAN_VISIBLE_TEXT,
                    meta: {},
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      vanSpecId,
      pool
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM specs WHERE id = $1', [vanSpecId]);
  });

  it(
    'an unmodified generated DOCX round-trips with an empty diff — the hidden run never ' +
      'leaks into the object-interior text merge extracts',
    async () => {
      const generateRes = await fetch(`${baseUrl}/specs/${vanSpecId}/generate`, {
        method: 'POST',
      });
      expect(generateRes.status).toBe(200);
      const buffer = Buffer.from(await generateRes.arrayBuffer());

      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }),
        'object-vanish.docx'
      );
      const diffRes = await fetch(`${baseUrl}/specs/${vanSpecId}/diff`, {
        method: 'POST',
        body: form,
      });
      const body = (await diffRes.json()) as ApiResponse<DiffResult>;

      expect(diffRes.status).toBe(200);
      expect(body.data).toEqual({
        added: [],
        modified: [],
        deleted: [],
        conflicts: [],
        objectConflicts: [],
        warnings: [],
      });
    }
  );
});

/**
 * #652: a textBox-kind body object, whose blob root is the HOST body
 * paragraph (`w:p`) carrying the `w:r > w:drawing` run — the capture shape
 * `parser/docx/body-objects.ts` documents in its module comment and
 * `buildTextBoxObject` actually produces (`blob: [anchored.node]`, where
 * `anchorInteriorParagraphs` preserves the root's own tag and only wraps
 * INTERIOR paragraphs with SDT anchors).
 *
 * A table's blob root is the `w:tbl` itself, which is also exactly what
 * `merge/extract.ts`'s `walkObjectBlocks` matches — so the table tier is
 * symmetric and every existing table-based test passes. For a textBox the
 * two sides used to hash different trees: base fingerprinted the host `w:p`,
 * theirs fingerprinted the bare `w:drawing`, so `fingerprintsDiverge` was
 * ALWAYS true and any untouched round trip false-reported an objectConflict.
 */
function anchoredTextBoxMeta(anchorUuid: string, text: string): ObjectMeta {
  const anchoredInterior: ObjectBlobNode = {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `specr-uuid-${anchorUuid}` } }] },
      { 'w:sdtContent': [{ 'w:p': [{ 'w:r': [{ 'w:t': [{ '#text': text }] }] }] }] },
    ],
  } as ObjectBlobNode;
  return {
    kind: 'textBox',
    floating: false,
    generation: 'drawingml',
    blob: [
      {
        'w:p': [
          {
            'w:r': [
              {
                'w:drawing': [
                  {
                    'wp:inline': [
                      {
                        'a:graphic': [
                          {
                            'a:graphicData': [
                              {
                                'wps:wsp': [
                                  { 'wps:txbx': [{ 'w:txbxContent': [anchoredInterior] }] },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// #652: the textBox counterpart of the table-kind wiring test above. Proved
// at the real wiring — DB → generateDocx → extractContentControls →
// getObjectStructuralSnapshots → computeDiff — because the asymmetry is
// between two production call sites (diff.ts fingerprints the stored blob
// root; extract.ts fingerprints the matched OBJECT_BLOCK_TAGS node), so a
// unit test on either side alone cannot see it.
describe('body-level object round-trip — textBox fingerprint symmetry (#652)', () => {
  const TB_PART_ID = randomUUID();
  const TB_OBJECT_ID = randomUUID();
  const TB_TEXT_ID = randomUUID();
  const TB_TEXT = 'Text box interior paragraph.';
  let tbSpecId: string;

  beforeAll(async () => {
    tbSpecId = await createSpec({
      section: '09 91 26',
      title: 'Object TextBox Diff Wiring Spec',
      source: `d652diff_${randomUUID().slice(0, 8)}`,
    });
    await insertTree(
      {
        id: tbSpecId,
        section: '09 91 26',
        title: 'Object TextBox Diff Wiring Spec',
        parts: [
          {
            id: TB_PART_ID,
            type: 'part',
            text: 'GENERAL',
            meta: {},
            children: [
              {
                id: TB_OBJECT_ID,
                type: 'object',
                text: '',
                meta: { object: anchoredTextBoxMeta(TB_TEXT_ID, TB_TEXT) },
                children: [
                  {
                    id: TB_TEXT_ID,
                    type: 'objectText',
                    text: TB_TEXT,
                    meta: {},
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
      tbSpecId,
      pool
    );
  });

  afterAll(async () => {
    // id-scoped teardown: only the spec row this describe block created.
    await pool.query('DELETE FROM specs WHERE id = $1', [tbSpecId]);
  });

  it('an unmodified generated DOCX round-trips with ZERO objectConflicts', async () => {
    const generateRes = await fetch(`${baseUrl}/specs/${tbSpecId}/generate`, { method: 'POST' });
    expect(generateRes.status).toBe(200);
    const buffer = Buffer.from(await generateRes.arrayBuffer());

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: DOCX_MIME }),
      'object-textbox.docx'
    );
    const diffRes = await fetch(`${baseUrl}/specs/${tbSpecId}/diff`, {
      method: 'POST',
      body: form,
    });
    const body = (await diffRes.json()) as ApiResponse<DiffResult>;

    expect(diffRes.status).toBe(200);
    // The assertion that fails without the #652 fix: base hashed the host
    // w:p, theirs hashed the bare w:drawing, so objectConflicts held one
    // entry.
    //
    // Non-vacuity is established by mutation, not by this shape: reverting
    // fingerprintRoot's host-paragraph pick makes ONLY this test fail, and it
    // fails carrying BOTH a base and a theirs fingerprint — which
    // detectObjectConflicts emits only for a block findMatchingBlock actually
    // matched by interior uuid, so the findInteriorUuids path is provably
    // live here. (Asserting the whole diff rather than objectConflicts alone
    // is broader coverage of the object round trip, but it is NOT by itself a
    // guard on findInteriorUuids: theirsControlled is built by walkBlocks
    // independently, so interior text would still round-trip cleanly if
    // interior-uuid collection regressed. extract.test.ts pins that path.)
    expect(body.data).toEqual({
      added: [],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    });
  });
});
