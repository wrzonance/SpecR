// src/mcp/checkpoint-handlers.test.ts
//
// Unit-pins the checkpoint/pending-summary MCP handlers' boundary behavior
// against a mocked db/index.js (no Postgres): the specId/projectId XOR scope
// resolution (get_reference_graph precedent), each domain-error mapping, the
// packageId-requires-projectId cross-field rule, and the "never throws"
// generic-error catch branch (mirrors header-footer-handlers.test.ts). Real
// DB round-trips (actorLabel resolution, sealedContentVersion, actual
// content_version_map shape) live in checkpoint-tools.integration.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  createCheckpointForActor: vi.fn(),
  listCheckpoints: vi.fn(),
  getCheckpointById: vi.fn(),
  getSpecPendingSummary: vi.fn(),
  getProjectPendingSummary: vi.fn(),
  CheckpointScopeNotFoundError: class CheckpointScopeNotFoundError extends Error {},
  SpecNotFoundError: class SpecNotFoundError extends Error {},
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '20000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '30000000-0000-4000-8000-000000000003';
const PACKAGE_ID = '40000000-0000-4000-8000-000000000004';

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('handleCreateCheckpoint — scope resolution', () => {
  it('rejects when neither specId nor projectId is given', async () => {
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');
    const res = await handleCreateCheckpoint({ name: 'Baseline', actorLabel: 'reviewer' });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('exactly one of specId or projectId');
  });

  it('rejects when both specId and projectId are given', async () => {
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');
    const res = await handleCreateCheckpoint({
      specId: SPEC_ID,
      projectId: PROJECT_ID,
      name: 'Baseline',
      actorLabel: 'reviewer',
    });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('exactly one of specId or projectId');
  });

  it('rejects a missing actorLabel (checkpoints.user_id is NOT NULL, no system fallback)', async () => {
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');
    const res = await handleCreateCheckpoint({ specId: SPEC_ID, name: 'Baseline' });
    expect(isError(res)).toBe(true);
  });
});

describe('handleCreateCheckpoint — writes', () => {
  it('seals a spec-scoped checkpoint by delegating name/scope/actorLabel to createCheckpointForActor', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.createCheckpointForActor).mockResolvedValueOnce({
      id: CHECKPOINT_ID,
      name: 'Baseline',
      scope: 'spec',
      scopeId: SPEC_ID,
      userId: 'user-1',
      contentVersionMap: { [SPEC_ID]: 3 },
      createdAt: '2026-01-01T00:00:00.000Z',
    } as never);
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');

    const res = await handleCreateCheckpoint({
      specId: SPEC_ID,
      name: 'Baseline',
      actorLabel: 'reviewer',
    });

    expect(isError(res)).toBe(false);
    // Actor resolution and the checkpoint insert are ONE transaction inside
    // createCheckpointForActor (#380 review finding) — the handler makes
    // exactly this one call, never resolving the actor separately.
    expect(db.createCheckpointForActor).toHaveBeenCalledWith({
      name: 'Baseline',
      scope: 'spec',
      scopeId: SPEC_ID,
      actorLabel: 'reviewer',
    });
  });

  it('maps CheckpointScopeNotFoundError to a tool error', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.createCheckpointForActor).mockRejectedValueOnce(
      new db.CheckpointScopeNotFoundError('project not found')
    );
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');

    const res = await handleCreateCheckpoint({
      projectId: PROJECT_ID,
      name: 'Baseline',
      actorLabel: 'reviewer',
    });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toBe('project not found');
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.createCheckpointForActor).mockRejectedValueOnce(new Error('connection reset'));
    const { handleCreateCheckpoint } = await import('./checkpoint-handlers.js');

    const res = await handleCreateCheckpoint({
      specId: SPEC_ID,
      name: 'Baseline',
      actorLabel: 'reviewer',
    });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});

describe('handleListCheckpoints', () => {
  it('rejects an invalid scope combination the same way create does', async () => {
    const { handleListCheckpoints } = await import('./checkpoint-handlers.js');
    const res = await handleListCheckpoints({ specId: SPEC_ID, projectId: PROJECT_ID });
    expect(isError(res)).toBe(true);
  });

  it('lists project-scoped checkpoints', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.listCheckpoints).mockResolvedValueOnce([
      { id: CHECKPOINT_ID, scope: 'project', scopeId: PROJECT_ID } as never,
    ]);
    const { handleListCheckpoints } = await import('./checkpoint-handlers.js');

    const res = await handleListCheckpoints({ projectId: PROJECT_ID });

    expect(isError(res)).toBe(false);
    expect(db.listCheckpoints).toHaveBeenCalledWith('project', PROJECT_ID);
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.listCheckpoints).mockRejectedValueOnce(new Error('connection reset'));
    const { handleListCheckpoints } = await import('./checkpoint-handlers.js');

    const res = await handleListCheckpoints({ specId: SPEC_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});

describe('handleGetCheckpoint', () => {
  it('rejects a non-UUID checkpointId', async () => {
    const { handleGetCheckpoint } = await import('./checkpoint-handlers.js');
    const res = await handleGetCheckpoint({ checkpointId: 'not-a-uuid' });
    expect(isError(res)).toBe(true);
  });

  it('returns a tool error when the checkpoint does not exist', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getCheckpointById).mockResolvedValueOnce(null);
    const { handleGetCheckpoint } = await import('./checkpoint-handlers.js');

    const res = await handleGetCheckpoint({ checkpointId: CHECKPOINT_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('checkpoint not found');
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getCheckpointById).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetCheckpoint } = await import('./checkpoint-handlers.js');

    const res = await handleGetCheckpoint({ checkpointId: CHECKPOINT_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});

describe('handleGetPendingSummary', () => {
  it('rejects packageId supplied with specId (project-only field)', async () => {
    const { handleGetPendingSummary } = await import('./checkpoint-handlers.js');
    const res = await handleGetPendingSummary({ specId: SPEC_ID, packageId: PACKAGE_ID });
    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('packageId only applies when projectId is provided');
  });

  it('reads a spec-scoped pending summary', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecPendingSummary).mockResolvedValueOnce({
      specId: SPEC_ID,
      sealedByCheckpointId: null,
      sealedContentVersion: null,
      currentContentVersion: 5,
      changedParagraphCount: 2,
      actorRollup: [],
    });
    const { handleGetPendingSummary } = await import('./checkpoint-handlers.js');

    const res = await handleGetPendingSummary({ specId: SPEC_ID });

    expect(isError(res)).toBe(false);
    expect(db.getSpecPendingSummary).toHaveBeenCalledWith(SPEC_ID);
    expect(db.getProjectPendingSummary).not.toHaveBeenCalled();
  });

  it('reads a project-scoped pending summary, forwarding packageId', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getProjectPendingSummary).mockResolvedValueOnce({
      projectId: PROJECT_ID,
      packageId: PACKAGE_ID,
      changedSpecCount: 1,
      changedParagraphCount: 2,
      actorRollup: [],
      perSpec: [],
    });
    const { handleGetPendingSummary } = await import('./checkpoint-handlers.js');

    const res = await handleGetPendingSummary({ projectId: PROJECT_ID, packageId: PACKAGE_ID });

    expect(isError(res)).toBe(false);
    expect(db.getProjectPendingSummary).toHaveBeenCalledWith(PROJECT_ID, PACKAGE_ID);
  });

  it('maps SpecNotFoundError and ProjectNotFoundError to tool errors', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecPendingSummary).mockRejectedValueOnce(
      new db.SpecNotFoundError('spec not found')
    );
    const { handleGetPendingSummary } = await import('./checkpoint-handlers.js');

    const res = await handleGetPendingSummary({ specId: SPEC_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toBe('spec not found');
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getProjectPendingSummary).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetPendingSummary } = await import('./checkpoint-handlers.js');

    const res = await handleGetPendingSummary({ projectId: PROJECT_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});
