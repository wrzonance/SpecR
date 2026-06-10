import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, bulkUpsertTemplateRules } from '../db/index.js';
import type { Template, TemplateMeta, StyleNodeType, StyleRule } from '../db/index.js';

// ─── Test setup ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

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
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
  await pool.end();
});

// Track created template names for cleanup.
const cleanupNames: string[] = [];

afterEach(async () => {
  for (const name of cleanupNames.splice(0)) {
    await pool.query(`DELETE FROM style_templates WHERE name = $1`, [name]);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

// Create a template and register its name for cleanup.
async function createTemplate(name: string, owner?: string): Promise<TemplateMeta> {
  cleanupNames.push(name);
  const body: Record<string, string> = { name };
  if (owner !== undefined) body['owner'] = owner;
  const res = await post('/templates', body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { success: true; data: TemplateMeta };
  return json.data;
}

// A valid rules array for testing.
const VALID_RULES = [
  {
    nodeType: 'part',
    properties: { rPr: { b: true, sz: 20 } },
  },
  {
    nodeType: 'article',
    properties: { rPr: { b: false } },
  },
];

// ─── POST /templates ──────────────────────────────────────────────────────────

describe('POST /templates', () => {
  it('201 — returns TemplateMeta, no rules', async () => {
    const name = `crud-create-${Date.now()}`;
    cleanupNames.push(name);

    const res = await post('/templates', { name });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(name);
    expect(body.data.owner).toBeNull();
    expect(body.data.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(body.data.createdAt).toBeDefined();
  });

  it('201 — with owner', async () => {
    const name = `crud-create-owner-${Date.now()}`;
    cleanupNames.push(name);

    const res = await post('/templates', { name, owner: 'ACME Corp' });
    expect(res.status).toBe(201);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta };
    expect(body.data.owner).toBe('ACME Corp');
  });

  it('409 — duplicate name', async () => {
    const name = `crud-dup-${Date.now()}`;
    cleanupNames.push(name);

    await post('/templates', { name });
    const second = await post('/templates', { name });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { success: false; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('already exists');
  });

  it('422 — missing name', async () => {
    const res = await post('/templates', { owner: 'someone' });
    expect(res.status).toBe(422);
  });

  it('422 — empty name string', async () => {
    const res = await post('/templates', { name: '' });
    expect(res.status).toBe(422);
  });
});

// ─── GET /templates ───────────────────────────────────────────────────────────

describe('GET /templates', () => {
  it('200 — contains created template', async () => {
    const name = `crud-list-${Date.now()}`;
    cleanupNames.push(name);
    await post('/templates', { name });

    const res = await get('/templates');
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const found = body.data.find((t) => t.name === name);
    expect(found).toBeDefined();
    // List items are TemplateMeta — no rules array
    expect((found as TemplateMeta & { rules?: unknown }).rules).toBeUndefined();
  });
});

// ─── GET /templates/:id ───────────────────────────────────────────────────────

describe('GET /templates/:id', () => {
  it('200 — full template with rules', async () => {
    const meta = await createTemplate(`crud-get-${Date.now()}`);

    // Seed some rules first so we can verify they come back
    await post(`/templates/${meta.id}/rules`, { rules: VALID_RULES });

    const res = await get(`/templates/${meta.id}`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: Template };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(meta.id);
    expect(Array.isArray(body.data.rules)).toBe(true);
    expect(body.data.rules.length).toBe(2);
  });

  it('404 — unknown uuid', async () => {
    const res = await get('/templates/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('400 — non-uuid id', async () => {
    const res = await get('/templates/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /templates/:id ─────────────────────────────────────────────────────

describe('PATCH /templates/:id', () => {
  it('200 — rename', async () => {
    const meta = await createTemplate(`crud-patch-rename-${Date.now()}`);
    const newName = `crud-patch-renamed-${Date.now()}`;
    cleanupNames.push(newName);

    const res = await patch(`/templates/${meta.id}`, { name: newName });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta };
    expect(body.data.name).toBe(newName);
    expect(body.data.id).toBe(meta.id);
  });

  it('200 — set owner', async () => {
    const meta = await createTemplate(`crud-patch-owner-${Date.now()}`);

    const res = await patch(`/templates/${meta.id}`, { owner: 'NewOwner' });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta };
    expect(body.data.owner).toBe('NewOwner');
  });

  it('200 — clear owner via null', async () => {
    const meta = await createTemplate(`crud-patch-clear-owner-${Date.now()}`, 'InitialOwner');

    const res = await patch(`/templates/${meta.id}`, { owner: null });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: TemplateMeta };
    expect(body.data.owner).toBeNull();
  });

  it('409 — rename to already-taken name', async () => {
    const takenName = `crud-taken-${Date.now()}`;
    await createTemplate(takenName);
    const meta = await createTemplate(`crud-patch-conflict-${Date.now()}`);

    const res = await patch(`/templates/${meta.id}`, { name: takenName });
    expect(res.status).toBe(409);
  });

  it('404 — unknown template', async () => {
    const res = await patch('/templates/00000000-0000-0000-0000-000000000000', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('422 — empty body (no fields)', async () => {
    const meta = await createTemplate(`crud-patch-empty-${Date.now()}`);
    const res = await patch(`/templates/${meta.id}`, {});
    // Validation failure → 422 (validateBody uses 422)
    expect(res.status).toBe(422);
  });

  it('400 — non-uuid id', async () => {
    const res = await patch('/templates/not-a-uuid', { name: 'x' });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /templates/:id ────────────────────────────────────────────────────

describe('DELETE /templates/:id', () => {
  it('204 — template and rules cascade-deleted', async () => {
    const name = `crud-delete-${Date.now()}`;
    cleanupNames.push(name);
    const meta = await createTemplate(name);

    // Seed rules
    await post(`/templates/${meta.id}/rules`, { rules: VALID_RULES });

    const res = await del(`/templates/${meta.id}`);
    expect(res.status).toBe(204);

    // Verify gone from DB
    const dbCheck = await pool.query(`SELECT 1 FROM style_templates WHERE id = $1`, [meta.id]);
    expect(dbCheck.rows).toHaveLength(0);

    // Verify rules cascade-deleted
    const rulesCheck = await pool.query(`SELECT 1 FROM style_rules WHERE template_id = $1`, [
      meta.id,
    ]);
    expect(rulesCheck.rows).toHaveLength(0);
  });

  it('404 — unknown template', async () => {
    const res = await del('/templates/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('400 — non-uuid id', async () => {
    const res = await del('/templates/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

// ─── POST /templates/:id/rules ────────────────────────────────────────────────

describe('POST /templates/:id/rules', () => {
  it('200 — bulk seeds rules; full Template returned', async () => {
    const meta = await createTemplate(`crud-rules-seed-${Date.now()}`);

    const res = await post(`/templates/${meta.id}/rules`, { rules: VALID_RULES });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: Template };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(meta.id);
    expect(Array.isArray(body.data.rules)).toBe(true);
    expect(body.data.rules.length).toBe(2);

    const nodeTypes = body.data.rules.map((r) => r.nodeType);
    expect(nodeTypes).toContain('part');
    expect(nodeTypes).toContain('article');
  });

  it('200 — unknown OOXML key round-trips', async () => {
    const meta = await createTemplate(`crud-rules-unknown-key-${Date.now()}`);

    const rulesWithUnknown = [
      {
        nodeType: 'part',
        properties: {
          rPr: { b: true },
          // Unknown OOXML key that should round-trip via JSONB catchall
          unknownOoXmlProp: 'vendor-specific-value',
        },
      },
    ];

    const res = await post(`/templates/${meta.id}/rules`, { rules: rulesWithUnknown });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: Template };
    const partRule = body.data.rules.find((r) => r.nodeType === 'part');
    expect(partRule).toBeDefined();
    // Unknown key must be preserved in the round-trip
    expect((partRule?.properties as Record<string, unknown>)['unknownOoXmlProp']).toBe(
      'vendor-specific-value'
    );
  });

  it('200 — re-bulk updates not duplicates', async () => {
    const meta = await createTemplate(`crud-rules-update-${Date.now()}`);

    await post(`/templates/${meta.id}/rules`, {
      rules: [{ nodeType: 'part', properties: { rPr: { b: true } } }],
    });

    const res = await post(`/templates/${meta.id}/rules`, {
      rules: [{ nodeType: 'part', properties: { rPr: { b: false, sz: 24 } } }],
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as { success: boolean; data: Template };
    const partRules = body.data.rules.filter((r) => r.nodeType === 'part');
    // Must be exactly 1 — upsert, not duplicate insert
    expect(partRules).toHaveLength(1);
    expect(partRules[0]?.properties.rPr?.b).toBe(false);
    expect(partRules[0]?.properties.rPr?.sz).toBe(24);
  });

  it('422 — non-enum nodeType', async () => {
    const meta = await createTemplate(`crud-rules-bad-type-${Date.now()}`);

    const res = await post(`/templates/${meta.id}/rules`, {
      rules: [{ nodeType: 'not-a-valid-type', properties: {} }],
    });
    expect(res.status).toBe(422);
  });

  it('404 — unknown template', async () => {
    const res = await post('/templates/00000000-0000-0000-0000-000000000000/rules', {
      rules: VALID_RULES,
    });
    expect(res.status).toBe(404);
  });

  it('atomicity — invalid rule rejected at Zod layer, zero writes', async () => {
    const meta = await createTemplate(`crud-rules-atomic-${Date.now()}`);

    // One valid rule + one with a non-enum nodeType: validateBody rejects the
    // whole request (422) BEFORE any DB write. The DB-level transactional path
    // is covered separately below ('bulk upsert: mid-batch DB CHECK failure…').
    const mixedRules = [
      { nodeType: 'part', properties: { rPr: { b: true } } },
      { nodeType: 'invalid-type', properties: {} },
    ];

    const res = await post(`/templates/${meta.id}/rules`, { rules: mixedRules });
    expect(res.status).toBe(422);

    // Verify zero rules were written
    const rulesCheck = await pool.query(`SELECT 1 FROM style_rules WHERE template_id = $1`, [
      meta.id,
    ]);
    expect(rulesCheck.rows).toHaveLength(0);
  });
});

// ─── DB-layer transactional rollback ──────────────────────────────────────────

describe('bulkUpsertTemplateRules (db layer)', () => {
  it('bulk upsert: mid-batch DB CHECK failure rolls back ALL rule writes (FOR UPDATE txn)', async () => {
    const meta = await createTemplate(`crud-rules-rollback-${Date.now()}`);

    // upsertStyleRulesBulk only Zod-parses `properties` — nodeType goes to SQL
    // verbatim. 'bogus' passes the TypeScript layer via a test-only cast, the
    // VALID first rule inserts, then 'bogus' violates style_rules_node_type_check
    // (pg 23514) mid-batch. The transaction must roll back the valid insert too.
    const validRule: StyleRule = { nodeType: 'part', properties: { rPr: { b: true } } };
    const bogusRule: StyleRule = {
      nodeType: 'bogus' as StyleNodeType, // test-only cast to reach the DB CHECK
      properties: {},
    };

    await expect(bulkUpsertTemplateRules(meta.id, [validRule, bogusRule])).rejects.toThrow();

    // The valid first insert must have been rolled back — zero rows.
    const rulesCheck = await pool.query(`SELECT 1 FROM style_rules WHERE template_id = $1`, [
      meta.id,
    ]);
    expect(rulesCheck.rows).toHaveLength(0);

    // The template row itself must survive (only the rule batch rolled back).
    const tmplCheck = await pool.query(`SELECT 1 FROM style_templates WHERE id = $1`, [meta.id]);
    expect(tmplCheck.rows).toHaveLength(1);
  });
});
