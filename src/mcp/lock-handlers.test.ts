// src/mcp/lock-handlers.test.ts
//
// #569: lock_spec on a held spec previously folded holder/expiresAt into a
// prose sentence only, so an MCP client had to regex it to schedule a retry
// — unlike REST's PUT /specs/:id/lock 409 body, which returns holder and
// expiresAt as real fields (src/api/locks.ts). Pins that the MCP tool now
// carries the same fields as structuredContent alongside the unchanged
// human-readable text.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  getLock: vi.fn(),
  findSpecById: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000001';

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]?.text ?? '';
}

function structuredContentOf(result: unknown): unknown {
  return (result as { structuredContent?: unknown }).structuredContent;
}

describe('lock_spec: held lock returns holder/expiresAt as structuredContent alongside prose (#569)', () => {
  it('returns structuredContent.holder/expiresAt matching the prose sentence', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findSpecById).mockResolvedValueOnce({ id: SPEC_ID } as never);
    vi.mocked(db.acquireLock).mockResolvedValueOnce({
      status: 'held',
      holder: 'editor-b',
      expiresAt: '2026-08-01T12:00:00.000Z',
    });
    const { handleLockSpec } = await import('./lock-handlers.js');

    const result = await handleLockSpec({ specId: SPEC_ID, holder: 'editor-a' });

    expect(result).toMatchObject({ isError: true });
    expect(textOf(result)).toBe('spec is locked by editor-b until 2026-08-01T12:00:00.000Z');
    expect(structuredContentOf(result)).toEqual({
      holder: 'editor-b',
      expiresAt: '2026-08-01T12:00:00.000Z',
    });
  });

  it('an acquired (non-held) lock carries no structuredContent (not error-shaped)', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.findSpecById).mockResolvedValueOnce({ id: SPEC_ID } as never);
    vi.mocked(db.acquireLock).mockResolvedValueOnce({
      status: 'acquired',
      lock: { specId: SPEC_ID, holder: 'editor-a', acquiredAt: '', expiresAt: '' },
    } as never);
    const { handleLockSpec } = await import('./lock-handlers.js');

    const result = await handleLockSpec({ specId: SPEC_ID, holder: 'editor-a' });

    expect(result).not.toMatchObject({ isError: true });
    expect(structuredContentOf(result)).toBeUndefined();
  });
});
