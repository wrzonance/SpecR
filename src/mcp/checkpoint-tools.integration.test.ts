// src/mcp/checkpoint-tools.integration.test.ts
//
// ADR-052 D3/D4/D9 (issue #380, task 10) — end-to-end MCP checkpoint/pending-
// summary handlers against real Postgres (mirrors paragraph-tools.integration
// .test.ts's precedent of driving handlers directly, not through the full
// registrar). Covers what checkpoint-handlers.test.ts's mocked-db suite
// cannot: actorLabel -> real users row resolution, the atomic
// content_version_map snapshot, sealedByCheckpointId/sealedContentVersion
// after a real seal, and the get_paragraph_history session view actually
// surfacing a checkpoint join.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../db/index.js';
import {
  handleCreateCheckpoint,
  handleListCheckpoints,
  handleGetCheckpoint,
  handleGetPendingSummary,
} from './checkpoint-handlers.js';
import { handleUpdateParagraph } from './paragraph-handlers.js';
import { handleGetParagraphHistory } from './history-handlers.js';
import type { ToolResult } from './handlers.js';

const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `mcp-checkpoint-test-${suffix}-${name}`;

let libraryId: string;
let specId: string;
let neverCheckpointedSpecId: string;
let projectId: string;
let bodyId: string;

function isToolError(res: ToolResult): boolean {
  return 'isError' in res && res.isError === true;
}

function parse<T>(res: ToolResult): T {
  return JSON.parse(res.content[0]!.text) as T;
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE tier = 'company' LIMIT 1`
  );
  const libRow = lib.rows[0];
  if (!libRow) throw new Error('no company library seeded — run pnpm seed');
  libraryId = libRow.id;

  const specRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 21 00', $1, 'arcat', $2) RETURNING id`,
    [label('spec'), libraryId]
  );
  specId = specRow.rows[0]!.id;

  const paraRow = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, NULL, 'pr1', 'Provide cabling.', 0, 1) RETURNING id`,
    [specId]
  );
  bodyId = paraRow.rows[0]!.id;

  // A spec no test ever seals — isolated from the create/list/get checkpoint
  // tests above, which seal `specId` as a side effect.
  const neverCheckpointedRow = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ('27 22 00', $1, 'arcat', $2) RETURNING id`,
    [label('never-checkpointed-spec'), libraryId]
  );
  neverCheckpointedSpecId = neverCheckpointedRow.rows[0]!.id;
  const neverCheckpointedPara = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
     VALUES ($1, NULL, 'pr1', 'Never sealed.', 0, 1) RETURNING id`,
    [neverCheckpointedSpecId]
  );
  // getSpecPendingSummary counts DISTINCT paragraph_versions rows, not paragraphs
  // rows — a real edit (not the raw INSERT above) is what actually produces one.
  await handleUpdateParagraph({
    specId: neverCheckpointedSpecId,
    nodeId: neverCheckpointedPara.rows[0]!.id,
    text: 'Never sealed, edited once.',
    actorLabel: label('actor'),
  });

  const projectRow = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [label('project')]
  );
  projectId = projectRow.rows[0]!.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [[specId, neverCheckpointedSpecId]]);
  await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
  await pool.query('DELETE FROM users WHERE label = $1', [label('actor')]);
});

describe('create_checkpoint / list_checkpoints / get_checkpoint MCP tools', () => {
  it('seals a spec-scoped checkpoint, resolving actorLabel to a real user', async () => {
    const created = await handleCreateCheckpoint({
      specId,
      name: 'Baseline review',
      actorLabel: label('actor'),
    });
    expect(isToolError(created)).toBe(false);
    const checkpoint = parse<{
      id: string;
      scope: string;
      scopeId: string;
      contentVersionMap: Record<string, number>;
    }>(created);
    expect(checkpoint.scope).toBe('spec');
    expect(checkpoint.scopeId).toBe(specId);
    expect(checkpoint.contentVersionMap[specId]).toBeTypeOf('number');

    const fetched = await handleGetCheckpoint({ checkpointId: checkpoint.id });
    expect(isToolError(fetched)).toBe(false);
    expect(parse<{ id: string }>(fetched).id).toBe(checkpoint.id);

    const listed = await handleListCheckpoints({ specId });
    expect(isToolError(listed)).toBe(false);
    const rows = parse<{ id: string }[]>(listed);
    expect(rows.some((r) => r.id === checkpoint.id)).toBe(true);
  });

  it('rejects create/list calls with neither or both of specId/projectId', async () => {
    expect(isToolError(await handleCreateCheckpoint({ name: 'x', actorLabel: 'a' }))).toBe(true);
    expect(isToolError(await handleListCheckpoints({ specId, projectId }))).toBe(true);
  });

  it('rejects sealing an unknown spec scope', async () => {
    const res = await handleCreateCheckpoint({
      specId: randomUUID(),
      name: 'Baseline',
      actorLabel: label('actor'),
    });
    expect(isToolError(res)).toBe(true);
  });

  it('returns a tool error for an unknown checkpoint id', async () => {
    const res = await handleGetCheckpoint({ checkpointId: randomUUID() });
    expect(isToolError(res)).toBe(true);
  });
});

describe('get_pending_summary MCP tool', () => {
  it('reports the whole recorded history as pending for a never-checkpointed spec', async () => {
    const res = await handleGetPendingSummary({ specId: neverCheckpointedSpecId });
    expect(isToolError(res)).toBe(false);
    const summary = parse<{
      sealedByCheckpointId: string | null;
      sealedContentVersion: number | null;
      changedParagraphCount: number;
    }>(res);
    expect(summary.sealedByCheckpointId).toBeNull();
    expect(summary.sealedContentVersion).toBeNull();
    expect(summary.changedParagraphCount).toBeGreaterThan(0);
  });

  it('reflects zero pending paragraphs immediately after a checkpoint seals current state', async () => {
    const sealed = await handleCreateCheckpoint({
      specId,
      name: 'Pending-summary baseline',
      actorLabel: label('actor'),
    });
    const checkpointId = parse<{ id: string }>(sealed).id;

    const res = await handleGetPendingSummary({ specId });
    const summary = parse<{ sealedByCheckpointId: string | null; changedParagraphCount: number }>(
      res
    );
    expect(summary.sealedByCheckpointId).toBe(checkpointId);
    expect(summary.changedParagraphCount).toBe(0);
  });

  it('rejects packageId supplied alongside specId', async () => {
    const res = await handleGetPendingSummary({ specId, packageId: randomUUID() });
    expect(isToolError(res)).toBe(true);
  });

  it('reads a project-scoped pending summary for a project with no owned specs', async () => {
    const res = await handleGetPendingSummary({ projectId });
    expect(isToolError(res)).toBe(false);
    const summary = parse<{ changedSpecCount: number; perSpec: unknown[] }>(res);
    expect(summary.changedSpecCount).toBe(0);
    expect(summary.perSpec).toEqual([]);
  });

  it('returns a tool error for an unknown project id', async () => {
    const res = await handleGetPendingSummary({ projectId: randomUUID() });
    expect(isToolError(res)).toBe(true);
  });
});

describe('get_paragraph_history MCP tool — checkpoint-sealed sessions (ADR-052 D3/D9)', () => {
  it('an edit after a checkpoint reads as a pending session; the checkpoint edit reads sealed', async () => {
    const target = await pool.query<{ id: string }>(
      `INSERT INTO paragraphs (spec_id, parent_id, node_type, text, position, base_version)
       VALUES ($1, NULL, 'pr1', 'Original text.', 5, 1) RETURNING id`,
      [specId]
    );
    const nodeId = target.rows[0]!.id;

    const firstEdit = await handleUpdateParagraph({
      specId,
      nodeId,
      text: 'Sealed edit.',
      actorLabel: label('actor'),
    });
    expect(isToolError(firstEdit)).toBe(false);

    const sealed = await handleCreateCheckpoint({
      specId,
      name: 'Session-view baseline',
      actorLabel: label('actor'),
    });
    const checkpointId = parse<{ id: string }>(sealed).id;

    const secondEdit = await handleUpdateParagraph({
      specId,
      nodeId,
      text: 'Pending edit.',
      actorLabel: label('actor'),
    });
    expect(isToolError(secondEdit)).toBe(false);

    const history = await handleGetParagraphHistory({ specId, nodeId });
    expect(isToolError(history)).toBe(false);
    const sessions = parse<{ sealedByCheckpointId: string | null; afterText: string }[]>(history);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.sealedByCheckpointId).toBe(checkpointId);
    expect(sessions[0]!.afterText).toBe('Sealed edit.');
    expect(sessions[1]!.sealedByCheckpointId).toBeNull();
    expect(sessions[1]!.afterText).toBe('Pending edit.');
  });

  it('raw: true still returns the tier-0 entries, unaffected by any checkpoint', async () => {
    const res = await handleGetParagraphHistory({ specId, nodeId: bodyId, raw: true });
    expect(isToolError(res)).toBe(false);
    const entries = parse<{ version: number }[]>(res);
    expect(entries.length).toBeGreaterThan(0);
  });
});
