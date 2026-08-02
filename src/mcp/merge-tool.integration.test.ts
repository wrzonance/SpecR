import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import {
  createSpec,
  insertTree,
  pool,
  SYSTEM_ACTOR_LABEL,
  StaleVersionError,
  SpecWriteForbiddenError,
} from '../db/index.js';
import { gateErrorResponse } from '../api/edit-gate-response.js';
import { historyActor } from '../test-utils/history-actor.js';
import { handleApplyMerge } from './merge-handlers.js';
import type { ToolResult } from './handlers.js';

const ORIGINAL_TEXT = 'Provide copper patch panels.';
const REVISED_TEXT = 'Provide fiber patch panels.';
const MISSING = '00000000-0000-0000-0000-000000000000';
const cleanupIds: string[] = [];

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}
function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}
function textOf(res: ToolResult): string {
  return res.content[0]?.text ?? '';
}
function structuredContentOf(res: ToolResult): unknown {
  return 'structuredContent' in res ? res.structuredContent : undefined;
}

async function createSpecFixture(): Promise<{ specId: string; paragraphId: string }> {
  const paragraphId = randomUUID();
  const specId = await createSpec({
    section: '27 16 00',
    title: 'Merge MCP Spec',
    source: `mcp5_${randomUUID().slice(0, 8)}`,
  });
  cleanupIds.push(specId);
  await insertTree(
    {
      id: specId,
      section: '27 16 00',
      title: 'Merge MCP Spec',
      parts: [
        {
          id: randomUUID(),
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: randomUUID(),
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                { id: paragraphId, type: 'pr1', text: ORIGINAL_TEXT, meta: {}, children: [] },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
  return { specId, paragraphId };
}

function diffFor(paragraphId: string): Record<string, unknown> {
  return {
    added: [],
    modified: [
      { uuid: paragraphId, base: ORIGINAL_TEXT, theirs: REVISED_TEXT, ours: ORIGINAL_TEXT },
    ],
    deleted: [],
    conflicts: [],
    objectConflicts: [],
    warnings: [],
  };
}

async function paragraphText(id: string): Promise<string> {
  const r = await pool.query<{ text: string }>('SELECT text FROM paragraphs WHERE id = $1', [id]);
  return r.rows[0]?.text ?? '';
}

afterAll(async () => {
  if (cleanupIds.length) {
    await pool.query('DELETE FROM specs WHERE id = ANY($1::uuid[])', [cleanupIds]);
  }
});

describe('apply_merge MCP tool', () => {
  it('accepts one change: applies theirs text, returns { applied:1, rejected:0 }', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const res = await handleApplyMerge({
      specId,
      accept: [paragraphId],
      diff: diffFor(paragraphId),
    });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ applied: number; rejected: number }>(res)).toEqual({ applied: 1, rejected: 0 });
    expect(await paragraphText(paragraphId)).toBe(REVISED_TEXT);
  });

  it('empty accept rejects all entries without changing the paragraph', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const res = await handleApplyMerge({ specId, accept: [], diff: diffFor(paragraphId) });
    expect(isToolError(res)).toBe(false);
    expect(parse<{ applied: number; rejected: number }>(res)).toEqual({ applied: 0, rejected: 1 });
    expect(await paragraphText(paragraphId)).toBe(ORIGINAL_TEXT);
  });

  it('an unknown accepted UUID is a tool error (InvalidAcceptedChange → 400 in REST)', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const res = await handleApplyMerge({
      specId,
      accept: [randomUUID()],
      diff: diffFor(paragraphId),
    });
    expect(isToolError(res)).toBe(true);
  });

  it('a stale expectedVersion is a tool error (ADR-018 optimistic concurrency)', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const v = await pool.query<{ content_version: number }>(
      'SELECT content_version FROM specs WHERE id = $1',
      [specId]
    );
    const current = v.rows[0]?.content_version ?? 1;
    const res = await handleApplyMerge({
      specId,
      accept: [],
      diff: diffFor(paragraphId),
      expectedVersion: current + 100,
    });
    expect(isToolError(res)).toBe(true);
    // #583/ADR-085: mirrors REST's gateErrorResponse 409 body field-for-field
    // so an agent can re-read the current version instead of regexing prose.
    expect(structuredContentOf(res)).toEqual({ currentVersion: current });
    // Full prose too, including the trailing guidance clause (merge-handlers.ts:16) —
    // structuredContent alone leaves that clause unpinned at the integration boundary.
    expect(textOf(res)).toBe(
      `stale version — current contentVersion is ${current}; re-run get_spec_diff and retry`
    );
    // Cross-check against the actual REST gateErrorResponse (src/api/edit-gate-
    // response.ts) for an equivalent error over this same live currentVersion —
    // pins the parity claim against the real function, not a hardcoded literal.
    const rest = gateErrorResponse(new StaleVersionError('stale write', current));
    expect(rest?.status).toBe(409);
    expect(structuredContentOf(res)).toEqual({ currentVersion: rest?.body.currentVersion });
  });

  it('an archived spec is a write-forbidden tool error with no structuredContent (#583/ADR-085)', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [specId]);
    const res = await handleApplyMerge({ specId, accept: [], diff: diffFor(paragraphId) });
    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toBe('spec is archived and cannot be edited');
    expect(structuredContentOf(res)).toBeUndefined();
    expect('structuredContent' in res).toBe(false);
    // Cross-check against the actual REST gateErrorResponse: confirm its 409
    // body for this class genuinely carries nothing beyond `error`.
    const rest = gateErrorResponse(
      new SpecWriteForbiddenError('spec is archived and cannot be edited')
    );
    expect(rest?.status).toBe(409);
    expect(Object.keys(rest?.body ?? {}).sort((a, b) => a.localeCompare(b))).toEqual([
      'error',
      'success',
    ]);
  });

  it('a missing spec and a malformed diff are tool errors', async () => {
    expect(
      isToolError(
        await handleApplyMerge({ specId: MISSING, accept: [], diff: diffFor(randomUUID()) })
      )
    ).toBe(true);
    expect(
      isToolError(await handleApplyMerge({ specId: MISSING, accept: [], diff: { added: [] } }))
    ).toBe(true);
  });
});

describe('apply_merge MCP tool — actorLabel attribution (#377)', () => {
  it('a supplied actorLabel attributes the merge history row; response shape is unchanged', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const res = await handleApplyMerge({
      specId,
      accept: [paragraphId],
      diff: diffFor(paragraphId),
      actorLabel: 'mcp.merge.bot',
    });
    expect(isToolError(res)).toBe(false);
    const parsed = parse<{ applied: number; rejected: number }>(res);
    expect(Object.keys(parsed).sort((a, b) => a.localeCompare(b))).toEqual(['applied', 'rejected']);
    expect(await historyActor(pool, paragraphId, 2)).toBe('mcp.merge.bot');
  });

  it('omitting actorLabel attributes the merge history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const res = await handleApplyMerge({
      specId,
      accept: [paragraphId],
      diff: diffFor(paragraphId),
    });
    expect(isToolError(res)).toBe(false);
    expect(await historyActor(pool, paragraphId, 2)).toBe(SYSTEM_ACTOR_LABEL);
  });
});
