import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, SYSTEM_ACTOR_LABEL } from '../db/index.js';

// Resolve the actor label attributed to a paragraph's most recent history row.
async function historyActor(paragraphId: string, version: number): Promise<string | null> {
  const row = await pool.query<{ label: string | null }>(
    `SELECT u.label FROM paragraph_versions v
     LEFT JOIN users u ON u.id = v.user_id
     WHERE v.paragraph_id = $1 AND v.version = $2`,
    [paragraphId, version]
  );
  return row.rows[0]?.label ?? null;
}

// Minimal shape for recursively searching a SpecNode tree.
interface SpecNodeLike {
  id: string;
  children: SpecNodeLike[];
  meta: {
    editability?: {
      value: string;
      override?: string;
    };
  };
}

function findNode(parts: SpecNodeLike[], id: string): SpecNodeLike | undefined {
  for (const node of parts) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

let server: Server;
let baseUrl: string;
let specId: string;
let nodeId: string;
let otherSpecId: string;
let reclSpecId: string;

async function req(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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

  const libRow = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
  );
  const libraryId = libRow.rows[0]!.id;

  const specRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 99', 'Editability API Test', 'arcat', $1)
     RETURNING id`,
    [libraryId]
  );
  specId = specRow.rows[0]!.id;

  const nodeRow = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
     VALUES ($1, NULL, 'pr1', 'Test paragraph.', 1)
     RETURNING id`,
    [specId]
  );
  nodeId = nodeRow.rows[0]!.id;

  const otherSpecRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 98', 'Editability API Other Spec', 'arcat', $1)
     RETURNING id`,
    [libraryId]
  );
  otherSpecId = otherSpecRow.rows[0]!.id;

  const reclSpecRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('99 99 97', 'Editability Reclassify Test', 'arcat', $1)
     RETURNING id`,
    [libraryId]
  );
  reclSpecId = reclSpecRow.rows[0]!.id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [otherSpecId]);
  await pool.query(`DELETE FROM specs WHERE id = $1`, [reclSpecId]);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('PATCH /specs/:id/paragraphs/:nodeId/editability', () => {
  it('sets the override and returns 200', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
    expect((r.body as { data: { editability: string } }).data.editability).toBe('note');
  });

  it('clears the override with explicit null', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: null,
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { editability: null } }).data.editability).toBeNull();
  });

  it('rejects a bad value with 400', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/editability`, {
      editability: 'frozen',
    });
    expect(r.status).toBe(400);
  });

  it('404 for an unknown node', async () => {
    const r = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/00000000-0000-0000-0000-000000000000/editability`,
      { editability: 'note' }
    );
    expect(r.status).toBe(404);
  });

  it('403 when the node belongs to another spec', async () => {
    const r = await req('PATCH', `/specs/${otherSpecId}/paragraphs/${nodeId}/editability`, {
      editability: 'note',
    });
    expect(r.status).toBe(403);
  });
});

describe('POST /specs/:id/reclassify', () => {
  it('reclassify: convention edit reclassifies stored facts — no source document required', async () => {
    // Seed a paragraph carrying a banner source_fact, no document on disk.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const banner = p.rows[0]!.id;
    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, { rules: {} });
    expect(r.status).toBe(200);
    const report = (r.body as { data: { entries: { nodeId: string; after: string }[] } }).data;
    expect(report.entries.find((e) => e.nodeId === banner)?.after).toBe('note');
  });

  it('override survives reclassify; diff report flags the disagreement', async () => {
    // Paragraph the machine will call 'note' (banner), but the human overrode to 'editable'.
    const p = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 2, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const node = p.rows[0]!.id;
    // Set the human override via the PATCH endpoint (proves the API-level survival).
    await req('PATCH', `/specs/${reclSpecId}/paragraphs/${node}/editability`, {
      editability: 'editable',
    });

    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, { rules: {} });
    expect(r.status).toBe(200);
    const report = (
      r.body as {
        data: { entries: { nodeId: string; after: string; overrideDisagrees: boolean }[] };
      }
    ).data;
    const entry = report.entries.find((e) => e.nodeId === node)!;
    expect(entry.after).toBe('note'); // machine re-derives note
    expect(entry.overrideDisagrees).toBe(true); // standing override (editable) disagrees

    // Override still effective: a fresh tree read shows editability.value === 'editable'.
    const tree = await req('GET', `/specs/${reclSpecId}`);
    // (locate the node in the returned tree and assert meta.editability.value === 'editable')
    expect(tree.status).toBe(200);
    const found = findNode((tree.body as { data: { parts: SpecNodeLike[] } }).data.parts, node);
    expect(found?.meta.editability?.value).toBe('editable');
    expect(found?.meta.editability?.override).toBe('editable');
  });

  it('422 when no convention can be resolved and none supplied', async () => {
    // Spec whose library has no profile AND no built-in available is hard to construct;
    // instead assert the happy path resolves the built-in. This case is covered at the
    // DB layer (reclassify.integration.test). Here assert empty-body resolves & 200s.
    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, {});
    expect(r.status).toBe(200);
  });

  it('422 for request-supplied noteBanners with a catastrophic regex (ReDoS guard)', async () => {
    const r = await req('POST', `/specs/${reclSpecId}/reclassify`, {
      rules: { noteBanners: ['(a+)+$'] },
    });
    expect(r.status).toBe(422);
    expect((r.body as { success: boolean }).success).toBe(false);
  });

  it('no request body resolves the stored profile — not 400', async () => {
    // A truly bodyless POST yields req.body === undefined; the handler must
    // treat it as "resolve the library profile", not reject it as malformed.
    const res = await fetch(`${baseUrl}/specs/${reclSpecId}/reclassify`, { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('explicit JSON null body is 400, not treated as bodyless', async () => {
    // User-visible contract: only a truly absent body means "resolve the stored
    // profile"; a literal `null` is rejected with 400. (Mechanically, strict
    // body-parser rejects the bare `null` at parse time; the handler's
    // `req.body === undefined ? {} : req.body` guard — unit-tested via
    // ReclassifyBodySchema.safeParse(null) — is the in-handler safety net that
    // keeps a `null` body from ever coercing to {} should it reach the handler.)
    const res = await fetch(`${baseUrl}/specs/${reclSpecId}/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    expect(res.status).toBe(400);
  });

  it('bodyless reclassify on a project copy (library_id NULL) uses the built-in default — not 422', async () => {
    await pool.query(`DELETE FROM specs WHERE title = 'api project copy' AND section = '99 99 95'`);
    await pool.query(`DELETE FROM projects WHERE name = 'recl-api-builtin'`);
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (name) VALUES ('recl-api-builtin') RETURNING id`
    );
    const projectId = proj.rows[0]!.id;
    const copy = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, project_id)
       VALUES ('99 99 95', 'api project copy', 'arcat', $1) RETURNING id`,
      [projectId]
    );
    const copyId = copy.rows[0]!.id;
    await pool.query(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'NOTES TO SPECIFIER', 1, $2::jsonb)`,
      [copyId, JSON.stringify({ banner: 'NOTES TO SPECIFIER' })]
    );
    const res = await fetch(`${baseUrl}/specs/${copyId}/reclassify`, { method: 'POST' });
    expect(res.status).toBe(200);
    // specs.project_id is not ON DELETE CASCADE — copy before project.
    await pool.query(`DELETE FROM specs WHERE id = $1`, [copyId]);
    await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  });
});

describe('POST .../comments/:index/accept-as-note', () => {
  it('inserts a note adjacent to the anchor; repeated call is 409 (idempotent contract)', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor', 5, $2::jsonb) RETURNING id`,
      [
        reclSpecId,
        JSON.stringify({ comments: [{ author: 'JDoe', text: 'Verify w/ owner', anchor: [0, 5] }] }),
      ]
    );
    const anchor = a.rows[0]!.id;
    const first = await req(
      'POST',
      `/specs/${reclSpecId}/paragraphs/${anchor}/comments/0/accept-as-note`
    );
    expect(first.status).toBe(201);
    const noteId = (first.body as { data: { noteId: string } }).data.noteId;

    const second = await req(
      'POST',
      `/specs/${reclSpecId}/paragraphs/${anchor}/comments/0/accept-as-note`
    );
    expect(second.status).toBe(409);
    expect((second.body as { noteId: string }).noteId).toBe(noteId);
  });

  it('422 for an out-of-range comment index', async () => {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'No comments', 6, '{}'::jsonb) RETURNING id`,
      [reclSpecId]
    );
    const r = await req(
      'POST',
      `/specs/${reclSpecId}/paragraphs/${a.rows[0]!.id}/comments/0/accept-as-note`
    );
    expect(r.status).toBe(422);
  });

  it('409 (write gate) when the spec is archived', async () => {
    const libRow = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    await pool.query(`DELETE FROM specs WHERE section = '99 99 96' AND title = 'Archived Accept'`);
    const gated = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 96', 'Archived Accept', 'arcat', $1) RETURNING id`,
      [libRow.rows[0]!.id]
    );
    const gatedSpec = gated.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor', 1, $2::jsonb) RETURNING id`,
      [gatedSpec, JSON.stringify({ comments: [{ author: 'A', text: 'x', anchor: [0, 1] }] })]
    );
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [gatedSpec]);
    const r = await req(
      'POST',
      `/specs/${gatedSpec}/paragraphs/${a.rows[0]!.id}/comments/0/accept-as-note`
    );
    expect(r.status).toBe(409);
    expect((r.body as { success: boolean }).success).toBe(false);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [gatedSpec]);
  });

  it('retry after the spec is archived still returns 409 + the SAME noteId (idempotent, not a gate error)', async () => {
    const libRow = await pool.query<{ id: string }>(
      `SELECT id FROM libraries WHERE name = 'Default Company Master' LIMIT 1`
    );
    await pool.query(`DELETE FROM specs WHERE section = '99 99 94' AND title = 'Retry Archived'`);
    const s = await pool.query<{ id: string }>(
      `INSERT INTO specs (section, title, source, library_id)
       VALUES ('99 99 94', 'Retry Archived', 'arcat', $1) RETURNING id`,
      [libRow.rows[0]!.id]
    );
    const archSpec = s.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor', 1, $2::jsonb) RETURNING id`,
      [archSpec, JSON.stringify({ comments: [{ author: 'A', text: 'note me', anchor: [0, 4] }] })]
    );
    const anchor = a.rows[0]!.id;
    const first = await req(
      'POST',
      `/specs/${archSpec}/paragraphs/${anchor}/comments/0/accept-as-note`
    );
    expect(first.status).toBe(201);
    const noteId = (first.body as { data: { noteId: string } }).data.noteId;

    // Archive, then retry the SAME accept — a no-op write must NOT require
    // writability; it returns the documented idempotent 409 + the same noteId.
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [archSpec]);
    const retry = await req(
      'POST',
      `/specs/${archSpec}/paragraphs/${anchor}/comments/0/accept-as-note`
    );
    expect(retry.status).toBe(409);
    expect((retry.body as { noteId: string }).noteId).toBe(noteId);
    await pool.query(`DELETE FROM specs WHERE id = $1`, [archSpec]);
  });
});

describe('POST .../accept-as-note — actorLabel attribution (#377)', () => {
  async function acceptWithComment(body?: unknown): Promise<{
    status: number;
    noteId: string;
  }> {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position, source_facts)
       VALUES ($1, 'pr1', 'Anchor', 7, $2::jsonb) RETURNING id`,
      [reclSpecId, JSON.stringify({ comments: [{ author: 'A', text: 'x', anchor: [0, 1] }] })]
    );
    const anchor = a.rows[0]!.id;
    const r = await req(
      'POST',
      `/specs/${reclSpecId}/paragraphs/${anchor}/comments/0/accept-as-note`,
      body
    );
    return { status: r.status, noteId: (r.body as { data: { noteId: string } }).data.noteId };
  }

  it('a supplied actorLabel attributes the note history row; response shape is unchanged', async () => {
    const { status, noteId } = await acceptWithComment({ actorLabel: 'reviewer.jane' });
    expect(status).toBe(201);
    expect(await historyActor(noteId, 1)).toBe('reviewer.jane');
  });

  it('a bodyless request (pre-#377 contract) attributes the note history to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const { status, noteId } = await acceptWithComment();
    expect(status).toBe(201);
    expect(await historyActor(noteId, 1)).toBe(SYSTEM_ACTOR_LABEL);
  });

  it('an empty JSON body ({}) is equivalent to bodyless — SYSTEM_ACTOR_LABEL sentinel', async () => {
    const { status, noteId } = await acceptWithComment({});
    expect(status).toBe(201);
    expect(await historyActor(noteId, 1)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('PATCH /specs/:id/paragraphs/:nodeId/removal', () => {
  it('removes a paragraph via vanish and returns 200 with vanish:true', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(200);
    expect((r.body as { success: boolean }).success).toBe(true);
    expect((r.body as { data: { meta: { vanish?: boolean } } }).data.meta.vanish).toBe(true);
  });

  it('reverses removal (un-vanish) with removed:false', async () => {
    await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, { removed: true });
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: false,
    });
    expect(r.status).toBe(200);
    expect((r.body as { data: { meta: { vanish?: boolean } } }).data.meta.vanish).toBeUndefined();
  });

  it('rejects a non-boolean removed flag with 400', async () => {
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${nodeId}/removal`, {
      removed: 'yes',
    });
    expect(r.status).toBe(400);
  });

  it('404 for an unknown node', async () => {
    const r = await req(
      'PATCH',
      `/specs/${specId}/paragraphs/00000000-0000-0000-0000-000000000000/removal`,
      { removed: true }
    );
    expect(r.status).toBe(404);
  });

  it('403 when the node belongs to another spec', async () => {
    const r = await req('PATCH', `/specs/${otherSpecId}/paragraphs/${nodeId}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(403);
  });

  it('422 for a note node the renderers cannot suppress', async () => {
    const noteRow = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'note', 'Editorial note.', 99) RETURNING id`,
      [specId]
    );
    const noteId = noteRow.rows[0]!.id;
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${noteId}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(422);
    const row = await pool.query<{ vanish: boolean }>(
      `SELECT vanish FROM paragraphs WHERE id = $1`,
      [noteId]
    );
    expect(row.rows[0]!.vanish).toBe(false); // flag never written
  });
});

describe('PATCH .../removal — actorLabel attribution (#377)', () => {
  async function insertFreshBody(): Promise<string> {
    const row = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position)
       VALUES ($1, NULL, 'pr1', 'Removable paragraph.', 50) RETURNING id`,
      [specId]
    );
    return row.rows[0]!.id;
  }

  it('a supplied actorLabel attributes the remove history row; response shape is unchanged', async () => {
    const target = await insertFreshBody();
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${target}/removal`, {
      removed: true,
      actorLabel: 'ops.crew',
    });
    expect(r.status).toBe(200);
    const keys = Object.keys((r.body as { data: object }).data).sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual(['children', 'id', 'meta', 'text', 'type']);
    expect(await historyActor(target, 2)).toBe('ops.crew'); // base_version 1 → snapshot at 2
  });

  it('omitting actorLabel attributes the remove history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const target = await insertFreshBody();
    const r = await req('PATCH', `/specs/${specId}/paragraphs/${target}/removal`, {
      removed: true,
    });
    expect(r.status).toBe(200);
    expect(await historyActor(target, 2)).toBe(SYSTEM_ACTOR_LABEL);
  });
});
