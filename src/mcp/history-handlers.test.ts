// src/mcp/history-handlers.test.ts
//
// Unit-pins two invariants against a mocked db/index.js (no Postgres):
// 1. get_paragraph_history's raw/coalesced branch (ADR-052 D3/D9, issue #380
//    task 10) — the default call reads tier-1 coalesced sessions via
//    getCoalescedParagraphHistory; `raw: true` reads tier-0 entries via
//    getParagraphHistory instead. This was previously unpinned: the tool
//    always called the raw path (a pre-existing gap this task closes) so an
//    MCP agent could never see sealedByCheckpointId/sealedContentVersion.
// 2. get_history_diff accepts a checkpoint:<uuid> anchor unchanged — it
//    shares HistoryAnchorSchema with the REST route, so no MCP-layer
//    validation rejects the shape the checkpoint tools now produce — and
//    maps HistoryAnchorError to a tool error rather than throwing (mirrors
//    header-footer-handlers.test.ts's "never throws" pattern).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getParagraphHistory: vi.fn(),
  getCoalescedParagraphHistory: vi.fn(),
  getSpecHistory: vi.fn(),
  getSpecHistoryDiff: vi.fn(),
  HistoryAnchorError: class HistoryAnchorError extends Error {},
}));

vi.mock('../lib/env.js', () => ({
  config: { HISTORY_SESSION_WINDOW_MS: 1_800_000 },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000001';
const NODE_ID = '20000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '30000000-0000-4000-8000-000000000003';

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

describe('handleGetParagraphHistory — tier selection (ADR-052 D3/D9)', () => {
  it('defaults to coalesced tier-1 sessions, forwarding the session window from config', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getCoalescedParagraphHistory).mockResolvedValueOnce([
      { sealedByCheckpointId: null } as never,
    ]);
    const { handleGetParagraphHistory } = await import('./history-handlers.js');

    const res = await handleGetParagraphHistory({ specId: SPEC_ID, nodeId: NODE_ID });

    expect(isError(res)).toBe(false);
    expect(db.getCoalescedParagraphHistory).toHaveBeenCalledWith(
      SPEC_ID,
      NODE_ID,
      1_800_000,
      false
    );
    expect(db.getParagraphHistory).not.toHaveBeenCalled();
  });

  it('raw: true reads tier-0 entries instead', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getParagraphHistory).mockResolvedValueOnce([{ version: 1 } as never]);
    const { handleGetParagraphHistory } = await import('./history-handlers.js');

    const res = await handleGetParagraphHistory({ specId: SPEC_ID, nodeId: NODE_ID, raw: true });

    expect(isError(res)).toBe(false);
    expect(db.getParagraphHistory).toHaveBeenCalledWith(SPEC_ID, NODE_ID, false);
    expect(db.getCoalescedParagraphHistory).not.toHaveBeenCalled();
  });

  it('a null result (spec or paragraph not found) is a tool error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getCoalescedParagraphHistory).mockResolvedValueOnce(null);
    const { handleGetParagraphHistory } = await import('./history-handlers.js');

    const res = await handleGetParagraphHistory({ specId: SPEC_ID, nodeId: NODE_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('not found');
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getCoalescedParagraphHistory).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetParagraphHistory } = await import('./history-handlers.js');

    const res = await handleGetParagraphHistory({ specId: SPEC_ID, nodeId: NODE_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});

describe('handleGetHistoryDiff — checkpoint:<uuid> anchor (ADR-052 D3/D9)', () => {
  it('accepts a checkpoint:<uuid> anchor unchanged (shares HistoryAnchorSchema with REST)', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecHistoryDiff).mockResolvedValueOnce({ applied: [], rejected: [] } as never);
    const { handleGetHistoryDiff } = await import('./history-handlers.js');

    const res = await handleGetHistoryDiff({
      specId: SPEC_ID,
      from: `checkpoint:${CHECKPOINT_ID}`,
      to: 'current',
    });

    expect(isError(res)).toBe(false);
    expect(db.getSpecHistoryDiff).toHaveBeenCalledWith(
      SPEC_ID,
      `checkpoint:${CHECKPOINT_ID}`,
      'current'
    );
  });

  it('rejects a malformed checkpoint anchor before it ever reaches the db layer', async () => {
    const { handleGetHistoryDiff } = await import('./history-handlers.js');

    const res = await handleGetHistoryDiff({
      specId: SPEC_ID,
      from: 'checkpoint:not-a-uuid',
      to: 'current',
    });

    expect(isError(res)).toBe(true);
  });

  it('maps HistoryAnchorError (e.g. an unrelated checkpoint) to a tool error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecHistoryDiff).mockRejectedValueOnce(
      new db.HistoryAnchorError('checkpoint never sealed this spec')
    );
    const { handleGetHistoryDiff } = await import('./history-handlers.js');

    const res = await handleGetHistoryDiff({
      specId: SPEC_ID,
      from: `checkpoint:${CHECKPOINT_ID}`,
      to: 'current',
    });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toBe('checkpoint never sealed this spec');
  });

  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecHistoryDiff).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetHistoryDiff } = await import('./history-handlers.js');

    const res = await handleGetHistoryDiff({ specId: SPEC_ID, from: 'origin', to: 'current' });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});

describe('handleGetSpecHistory — never throws', () => {
  it('a non-domain rejection surfaces as Internal error, not a throw', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecHistory).mockRejectedValueOnce(new Error('connection reset'));
    const { handleGetSpecHistory } = await import('./history-handlers.js');

    const res = await handleGetSpecHistory({ specId: SPEC_ID });

    expect(isError(res)).toBe(true);
    expect(textOf(res)).toContain('Internal error');
  });
});
