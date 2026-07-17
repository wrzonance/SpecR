import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, SYSTEM_ACTOR_LABEL, lockedObjectMessage } from '../db/index.js';
import { historyActor } from '../test-utils/history-actor.js';

let server: Server;
let baseUrl: string;
let specId: string;
let otherSpecId: string;
let nodeId: string;

async function insertSpec(section: string, title: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'ufgs', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))
     RETURNING id`,
    [section, title]
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to insert test spec');
  return row.id;
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

  specId = await insertSpec('27 21 00', 'Structured Cabling');
  otherSpecId = await insertSpec('09 91 26', 'Painting');

  const para = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, NULL, 'pr1', 'Provide cabling.', 0, 1) RETURNING id`,
    [specId]
  );
  const paraRow = para.rows[0];
  if (!paraRow) throw new Error('failed to insert test paragraph');
  nodeId = paraRow.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specId, otherSpecId]]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('PATCH /specs/:id/paragraphs/:nodeId (integration)', () => {
  it('updates text and bumps base_version', async () => {
    const before = await pool.query<{ base_version: number }>(
      'SELECT base_version FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    const beforeVersion = before.rows[0]?.base_version ?? 0;

    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide Category 6A cabling.' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { id: string; type: string; text: string; children: unknown[] };
    };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(nodeId);
    expect(body.data.type).toBe('pr1');
    expect(body.data.text).toBe('Provide Category 6A cabling.');
    expect(Array.isArray(body.data.children)).toBe(true);

    const after = await pool.query<{ base_version: number; text: string }>(
      'SELECT base_version, text FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    expect(after.rows[0]?.text).toBe('Provide Category 6A cabling.');
    expect(after.rows[0]?.base_version).toBe(beforeVersion + 1);
  });

  it('articleRole — PATCH response derives the role for an edited article heading (ADR-033)', async () => {
    // Regression: buildSubtree (the PATCH response path) must mirror buildNodeTree
    // and derive meta.articleRole, so editing an article heading to a recognized
    // CSI title surfaces the role immediately — not only after a full-tree refetch.
    const article = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
       VALUES ($1, NULL, 'article', 'PLACEHOLDER', 0, 1) RETURNING id`,
      [specId]
    );
    const articleId = article.rows[0]?.id;
    if (!articleId) throw new Error('failed to insert test article');

    try {
      const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${articleId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '1.2 REFERENCES' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { type: string; meta: { articleRole?: string } };
      };
      expect(body.data.type).toBe('article');
      expect(body.data.meta.articleRole).toBe('references');
    } finally {
      await pool.query('DELETE FROM paragraphs WHERE id = $1', [articleId]);
    }
  });

  it('subtree leak — cross-spec child parented to node is excluded from response', async () => {
    // A malformed row in another spec points its parent_id at our node. The
    // recursive subtree fetch must stay scoped to the target spec and never
    // surface this foreign node (parent_id has no same-spec DB constraint).
    const foreign = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
       VALUES ($1, $2, 'pr2', 'Foreign leak node.', 0, 1) RETURNING id`,
      [otherSpecId, nodeId]
    );
    const foreignId = foreign.rows[0]?.id;
    if (!foreignId) throw new Error('failed to insert cross-spec child');

    try {
      const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Provide Category 6A cabling.' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { children: { id: string }[] };
      };
      const ids = body.data.children.map((child) => child.id);
      expect(ids).not.toContain(foreignId);
    } finally {
      await pool.query('DELETE FROM paragraphs WHERE id = $1', [foreignId]);
    }
  });

  it('returns 404 for an unknown nodeId', async () => {
    const unknown = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${unknown}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'whatever' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 403 when the nodeId belongs to a different spec', async () => {
    const before = await pool.query<{ text: string }>('SELECT text FROM paragraphs WHERE id = $1', [
      nodeId,
    ]);
    const beforeText = before.rows[0]?.text;

    const res = await fetch(`${baseUrl}/specs/${otherSpecId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'cross-spec edit' }),
    });
    expect(res.status).toBe(403);

    const unchanged = await pool.query<{ text: string }>(
      'SELECT text FROM paragraphs WHERE id = $1',
      [nodeId]
    );
    expect(unchanged.rows[0]?.text).toBe(beforeText);
  });

  it('returns 400 for empty text', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid nodeId', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/not-a-uuid`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'valid text' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid specId', async () => {
    const res = await fetch(`${baseUrl}/specs/not-a-uuid/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'valid text' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('PATCH paragraph — actorLabel attribution (#377)', () => {
  // nodeId is a single fixture mutated across the whole suite, so its snapshot
  // version is the live base_version, not a fixed number — resolve it, then
  // delegate to the shared label lookup (src/test-utils/history-actor.ts).
  async function actorAtLiveVersion(paragraphId: string): Promise<string | null> {
    const v = await pool.query<{ base_version: number }>(
      'SELECT base_version FROM paragraphs WHERE id = $1',
      [paragraphId]
    );
    return historyActor(pool, paragraphId, v.rows[0]?.base_version ?? -1);
  }

  it('a supplied actorLabel attributes the history row; response shape is unchanged', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide attributed cabling.', actorLabel: 'qa.bot' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    // Response is still a bare SpecNode — actorLabel is attribution-only, never echoed back.
    expect(Object.keys(body.data).sort((a, b) => a.localeCompare(b))).toEqual([
      'children',
      'id',
      'meta',
      'text',
      'type',
    ]);

    expect(await actorAtLiveVersion(nodeId)).toBe('qa.bot');
  });

  it('omitting actorLabel attributes the history row to the SYSTEM_ACTOR_LABEL sentinel — byte-identical to the pre-#377 path', async () => {
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide unattributed cabling.' }),
    });
    expect(res.status).toBe(200);
    expect(await actorAtLiveVersion(nodeId)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('PATCH paragraph — optimistic concurrency + edit gate (ADR-018)', () => {
  async function specVersion(id: string): Promise<number> {
    const r = await pool.query<{ content_version: number }>(
      'SELECT content_version FROM specs WHERE id = $1',
      [id]
    );
    return r.rows[0]?.content_version ?? 0;
  }

  it('bumps specs.content_version on a successful write', async () => {
    const before = await specVersion(specId);
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide bonded cabling.' }),
    });
    expect(res.status).toBe(200);
    expect(await specVersion(specId)).toBe(before + 1);
  });

  it('accepts a matching expectedVersion', async () => {
    const version = await specVersion(specId);
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Provide tested cabling.', expectedVersion: version }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects a stale expectedVersion with 409 and the current version in the body', async () => {
    const version = await specVersion(specId);
    const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${nodeId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      // version + 1 is a guaranteed-stale mismatch that always passes schema
      // validation (min 1). version - 1 could be 0 on an isolated run and 400
      // on the schema rather than exercising the 409 stale-version path.
      body: JSON.stringify({ text: 'doomed edit', expectedVersion: version + 1 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; currentVersion: number };
    expect(body.success).toBe(false);
    expect(body.currentVersion).toBe(version);
  });

  it('rejects writes to an archived spec with 409', async () => {
    const archived = await insertSpec('99 96 00', 'Archived Spec');
    const para = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
       VALUES ($1, NULL, 'pr1', 'Original.', 0, 1) RETURNING id`,
      [archived]
    );
    const archivedNode = para.rows[0]!.id;
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [archived]);
    try {
      const res = await fetch(`${baseUrl}/specs/${archived}/paragraphs/${archivedNode}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'edit on archived' }),
      });
      expect(res.status).toBe(409);
      const after = await pool.query<{ text: string }>(
        'SELECT text FROM paragraphs WHERE id = $1',
        [archivedNode]
      );
      expect(after.rows[0]?.text).toBe('Original.');
    } finally {
      await pool.query('DELETE FROM specs WHERE id = $1', [archived]);
    }
  });
});

describe('PATCH paragraph — locked-object guard (#519, ADR-072 decision 3)', () => {
  it('rejects a direct write to an object row with 422, leaving it unchanged', async () => {
    const objectRow = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
       VALUES ($1, NULL, 'object', '[TABLE]', 50, 1) RETURNING id`,
      [specId]
    );
    const objectId = objectRow.rows[0]?.id;
    if (!objectId) throw new Error('failed to insert test object row');

    try {
      const res = await fetch(`${baseUrl}/specs/${specId}/paragraphs/${objectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'attempted direct rewrite' }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      // Exact equality (not a substring match) against the shared helper (#519 review
      // finding) — this is the same string the MCP tool test below pins, so the two
      // surfaces are provably identical, not just each individually containing
      // "locked"/"objectText".
      expect(body.error).toBe(lockedObjectMessage('object'));

      const unchanged = await pool.query<{ text: string; base_version: number }>(
        'SELECT text, base_version FROM paragraphs WHERE id = $1',
        [objectId]
      );
      expect(unchanged.rows[0]?.text).toBe('[TABLE]');
      expect(unchanged.rows[0]?.base_version).toBe(1);
    } finally {
      await pool.query('DELETE FROM paragraphs WHERE id = $1', [objectId]);
    }
  });
});
