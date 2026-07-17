// src/mcp/onboarding.integration.test.ts
// JSON-RPC POST /mcp coverage for the onboarding/editability tools (#140):
// happy path + isError shape per tool, and the single-source parity assertion
// that review_editability evidence/confidence equals what getSpecTree surfaces.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { pool, createSpec, insertTree, getSpecTree, storeClassifications } from '../db/index.js';
import type { ClassifyResult } from '../conventions/index.js';
import { registerMcpRoutes } from './server.js';

let server: Server;
let baseUrl: string;
let specId: string;
const PART_ID = '40000000-0000-4000-8000-000000000001';
const ARTICLE_ID = '40000000-0000-4000-8000-000000000002';
const PR1_ID = '40000000-0000-4000-8000-000000000003';
const UNKNOWN_UUID = '00000000-0000-4000-8000-000000000000';

async function mcpTool(name: string, args: Record<string, unknown>): Promise<ToolRpcResult> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const payload = res.headers.get('content-type')?.includes('text/event-stream')
    ? (text
        .split('\n')
        .find((l) => l.startsWith('data: '))
        ?.slice(6) ?? '{}')
    : text;
  const raw = JSON.parse(payload) as { result: ToolRpcResult };
  return raw.result;
}

interface ToolRpcResult {
  readonly isError?: boolean;
  readonly content: { readonly type: string; readonly text: string }[];
}

function parseResult<T>(result: ToolRpcResult): T {
  return JSON.parse(result.content[0]?.text ?? '{}') as T;
}

// The machine's first verdict — distinct confidences so maxConfidence filtering
// is observable and a reclassify produces a real diff.
const CLASSIFICATION: ClassifyResult = [
  {
    nodeId: PR1_ID,
    editability: 'editable',
    confidence: 0.92,
    evidence: [{ rule: 'colorMeanings[0000FF]', fact: 'colors[0]' }],
  },
  {
    nodeId: ARTICLE_ID,
    editability: 'locked',
    confidence: 0.45,
    evidence: [{ rule: 'defaultEditability', detail: 'structural heading' }],
  },
];

beforeAll(async () => {
  const app = express();
  const restJson = express.json();
  app.use((req, res, next) => {
    if (req.path.startsWith('/mcp')) return next();
    restJson(req, res, next);
  });
  registerMcpRoutes(app, { rateLimitMax: 1000 });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3001;
  baseUrl = `http://localhost:${port}`;

  specId = await createSpec({ section: '09 91 23', title: 'Onboarding MCP Spec', source: 'arcat' });
  await insertTree(
    {
      id: specId,
      section: '09 91 23',
      title: 'Onboarding MCP Spec',
      parts: [
        {
          id: PART_ID,
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: ARTICLE_ID,
              type: 'article',
              text: 'REFERENCES',
              meta: {},
              children: [
                { id: PR1_ID, type: 'pr1', text: 'Coordinate work.', meta: {}, children: [] },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
  await storeClassifications(specId, CLASSIFICATION);
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [specId]);
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('tool: review_editability', () => {
  it('returns one entry per classified node with value/confidence/evidence', async () => {
    const result = await mcpTool('review_editability', { specId });
    expect(result.isError).not.toBe(true);
    const data = parseResult<{
      total: number;
      entries: { nodeId: string; value: string; confidence: number; evidence: unknown[] }[];
    }>(result);
    expect(data.total).toBe(2);
    const pr1 = data.entries.find((e) => e.nodeId === PR1_ID);
    expect(pr1).toMatchObject({ value: 'editable', confidence: 0.92 });
    expect(pr1?.evidence).toEqual([{ rule: 'colorMeanings[0000FF]', fact: 'colors[0]' }]);
  });

  it('evidence and confidence equal what getSpecTree surfaces (single source)', async () => {
    const result = await mcpTool('review_editability', { specId });
    const data = parseResult<{
      entries: { nodeId: string; value: string; confidence: number; evidence: unknown }[];
    }>(result);
    const tree = await getSpecTree(specId);
    const article = tree?.tree.parts[0]?.children[0];
    const pr1 = article?.children[0];
    const restEntries = [article, pr1].map((n) => ({
      nodeId: n?.id,
      value: n?.meta.editability?.value,
      confidence: n?.meta.editability?.confidence,
      evidence: n?.meta.editability?.evidence,
    }));
    for (const expected of restEntries) {
      const got = data.entries.find((e) => e.nodeId === expected.nodeId);
      expect(got).toMatchObject({
        value: expected.value,
        confidence: expected.confidence,
        evidence: expected.evidence,
      });
    }
  });

  it('maxConfidence filters to the low-confidence review queue', async () => {
    const result = await mcpTool('review_editability', { specId, maxConfidence: 0.6 });
    const data = parseResult<{ entries: { nodeId: string }[] }>(result);
    expect(data.entries.map((e) => e.nodeId)).toEqual([ARTICLE_ID]);
  });

  it('returns isError for an unknown specId', async () => {
    const result = await mcpTool('review_editability', { specId: UNKNOWN_UUID });
    expect(result.isError).toBe(true);
  });
});

describe('tool: get_onboarding_report', () => {
  it('returns editability summary, styleSource, and onboardingStatus', async () => {
    const result = await mcpTool('get_onboarding_report', { specId });
    expect(result.isError).not.toBe(true);
    const data = parseResult<{
      specId: string;
      styleSource: unknown;
      styleSourceNeeded: boolean;
      onboardingStatus: string;
      editability: { counts: Record<string, number> };
      hierarchy: { counts: Record<string, number> };
    }>(result);
    expect(data.specId).toBe(specId);
    expect(data.styleSource).toBeNull();
    expect(data.styleSourceNeeded).toBe(true);
    expect(data.editability.counts).toMatchObject({ editable: 1, locked: 1 });
    expect(data.hierarchy.counts['scored']).toBeTypeOf('number');
    expect(data.hierarchy.counts['unscored']).toBeTypeOf('number');
    expect(data.hierarchy.counts['belowThreshold']).toBeTypeOf('number');
  });

  it('returns isError for an unknown specId', async () => {
    const result = await mcpTool('get_onboarding_report', { specId: UNKNOWN_UUID });
    expect(result.isError).toBe(true);
  });
});

describe('tool: set_editability_override / clear_editability_override', () => {
  it('set override flips the effective value seen by review_editability', async () => {
    const set = await mcpTool('set_editability_override', {
      specId,
      nodeId: PR1_ID,
      editability: 'locked',
    });
    expect(set.isError).not.toBe(true);
    const review = await mcpTool('review_editability', { specId });
    const data = parseResult<{ entries: { nodeId: string; value: string; override?: string }[] }>(
      review
    );
    const pr1 = data.entries.find((e) => e.nodeId === PR1_ID);
    expect(pr1?.value).toBe('locked');
    expect(pr1?.override).toBe('locked');
  });

  it('clear override reverts to the machine verdict', async () => {
    await mcpTool('set_editability_override', { specId, nodeId: PR1_ID, editability: 'note' });
    const clear = await mcpTool('clear_editability_override', { specId, nodeId: PR1_ID });
    expect(clear.isError).not.toBe(true);
    const review = await mcpTool('review_editability', { specId });
    const data = parseResult<{ entries: { nodeId: string; value: string; override?: string }[] }>(
      review
    );
    const pr1 = data.entries.find((e) => e.nodeId === PR1_ID);
    expect(pr1?.value).toBe('editable');
    expect(pr1?.override).toBeUndefined();
  });

  it('returns isError when the node does not belong to the spec', async () => {
    const result = await mcpTool('set_editability_override', {
      specId,
      nodeId: UNKNOWN_UUID,
      editability: 'locked',
    });
    expect(result.isError).toBe(true);
  });

  it('returns isError for a malformed node uuid (schema rejection)', async () => {
    const result = await mcpTool('set_editability_override', {
      specId,
      nodeId: 'not-a-uuid',
      editability: 'locked',
    });
    expect(result.isError).toBe(true);
  });

  // ADR-072 decision 2: object/objectText editability is fixed at capture
  // time — the MCP surface must reject an override the same as REST (parity).
  it('returns isError when overriding an "object" node — editability fixation invariant (ADR-072 D2)', async () => {
    const obj = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1, 'object', '', 5) RETURNING id`,
      [specId]
    );
    const result = await mcpTool('set_editability_override', {
      specId,
      nodeId: obj.rows[0]!.id,
      editability: 'editable',
    });
    expect(result.isError).toBe(true);
    await pool.query(`DELETE FROM paragraphs WHERE id = $1`, [obj.rows[0]!.id]);
  });
});

describe('tool: reclassify_spec', () => {
  it('returns the before/after diff and persists by default', async () => {
    const result = await mcpTool('reclassify_spec', { specId });
    expect(result.isError).not.toBe(true);
    const data = parseResult<{
      specId: string;
      persisted: boolean;
      total: number;
      entries: unknown[];
    }>(result);
    expect(data.specId).toBe(specId);
    expect(data.persisted).toBe(true);
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('preview=true computes the diff without persisting', async () => {
    const result = await mcpTool('reclassify_spec', { specId, preview: true });
    const data = parseResult<{ persisted: boolean }>(result);
    expect(data.persisted).toBe(false);
  });

  it('returns isError for an unknown specId', async () => {
    const result = await mcpTool('reclassify_spec', { specId: UNKNOWN_UUID });
    expect(result.isError).toBe(true);
  });
});
