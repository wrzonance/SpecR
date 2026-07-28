import { describe, it, expect } from 'vitest';
import { coalesceParagraphSessions, type CoalescableHistoryEntry } from './session-coalesce.js';
import type { CheckpointBoundary } from './checkpoints.js';
import type { ParagraphHistoryOp } from './paragraph-history.js';

// ADR-052 D3 (issue #380, task 4) — the coalescer is the highest
// novel-logic-risk area the design spike flagged: two boundary bugs (join key,
// sealing off-by-one) were caught there and pinned into the ADR text. Every
// test below either exercises one of those pinned invariants directly or a
// supporting partition/grouping rule the invariants depend on.

const SESSION_WINDOW_MS = 30 * 60 * 1000;

interface EntryOverrides {
  readonly specId?: string;
  readonly custody?: 'origin' | 'spec';
  readonly version?: number;
  readonly text?: string;
  readonly nodeType?: string;
  readonly op?: ParagraphHistoryOp;
  readonly contentVersion?: number | null;
  readonly snapshotAt?: string;
  readonly userId?: string | null;
}

// Fixture gotcha (spike-confirmed): contentVersion and userId are legitimately
// nullable, so a plain `overrides.field ?? default` would silently collapse an
// explicit `null` override back to the default. `'field' in overrides` is the
// only way to tell "caller passed null on purpose" apart from "caller passed
// nothing" — the `?? null` after it only guards the pathological
// `{ field: undefined }` case, never the deliberate-null one.
// actorLabel is inert here — no coalescer rule branches on it, only userId —
// so a fixed placeholder (never null-vs-default ambiguous like userId/
// contentVersion) is enough; no override plumbing needed.
const DEFAULT_ENTRY: Omit<CoalescableHistoryEntry, 'contentVersion' | 'userId'> = {
  specId: 'spec-1',
  custody: 'spec',
  version: 1,
  text: 'text',
  nodeType: 'paragraph',
  op: 'edit',
  snapshotAt: '2026-07-01T00:00:00.000Z',
  actorLabel: null,
};

function historyEntry(overrides: EntryOverrides = {}): CoalescableHistoryEntry {
  return {
    ...DEFAULT_ENTRY,
    ...overrides,
    contentVersion: 'contentVersion' in overrides ? (overrides.contentVersion ?? null) : 1,
    userId: 'userId' in overrides ? (overrides.userId ?? null) : 'user-a',
  };
}

function boundary(
  checkpointId: string,
  contentVersion: number,
  at = '2026-07-01T00:00:00.000Z'
): CheckpointBoundary {
  return { checkpointId, at, contentVersion };
}

describe('coalesceParagraphSessions — purity and totality', () => {
  it('returns [] for empty entries without throwing', () => {
    expect(coalesceParagraphSessions([], [], SESSION_WINDOW_MS)).toEqual([]);
  });

  it('is pure: identical (entries, boundaries, windowMs) input yields identical output on repeat calls, without mutating the input', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:05:00.000Z' }),
      historyEntry({
        userId: 'user-b',
        version: 3,
        contentVersion: 3,
        snapshotAt: '2026-07-01T00:10:00.000Z',
      }),
    ];
    const boundaries = [boundary('cp-1', 2)];
    const entriesBefore = JSON.parse(JSON.stringify(entries)) as unknown;

    const first = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);
    const second = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);

    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(entries)) as unknown).toEqual(entriesBefore);
  });

  it('never throws across a mixed actor/gap/checkpoint/null-actor input', () => {
    const entries = [
      historyEntry({ op: 'insert', version: 1, contentVersion: 1 }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:05:00.000Z' }),
      historyEntry({
        userId: null,
        version: 3,
        contentVersion: null,
        snapshotAt: '2026-07-01T00:06:00.000Z',
      }),
      historyEntry({
        userId: 'user-b',
        version: 4,
        contentVersion: 4,
        snapshotAt: '2026-07-05T00:00:00.000Z',
      }),
    ];

    expect(() =>
      coalesceParagraphSessions(entries, [boundary('cp-1', 2)], SESSION_WINDOW_MS)
    ).not.toThrow();
  });
});

describe('coalesceParagraphSessions — partition is a strict cover of the input', () => {
  it('concatenating every session entries span in order reconstructs the original entries array exactly once each', () => {
    const entries = [
      historyEntry({
        op: 'insert',
        version: 1,
        contentVersion: 1,
        snapshotAt: '2026-07-01T00:00:00.000Z',
      }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:05:00.000Z' }),
      historyEntry({
        userId: null,
        version: 3,
        contentVersion: 3,
        snapshotAt: '2026-07-01T00:06:00.000Z',
      }),
      historyEntry({ version: 4, contentVersion: 4, snapshotAt: '2026-07-01T00:07:00.000Z' }),
      historyEntry({
        userId: 'user-b',
        version: 5,
        contentVersion: 5,
        snapshotAt: '2026-08-01T00:00:00.000Z',
      }),
      historyEntry({
        userId: 'user-b',
        version: 6,
        contentVersion: 6,
        snapshotAt: '2026-08-01T00:02:00.000Z',
      }),
    ];

    const sessions = coalesceParagraphSessions(entries, [boundary('cp-1', 3)], SESSION_WINDOW_MS);

    expect(sessions.flatMap((session) => session.entries)).toEqual(entries);
  });
});

describe('coalesceParagraphSessions — null-userId entries are always singleton sessions', () => {
  it('a null userId entry never coalesces with a neighboring same-actor entry, and breaks the run both before and after itself', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({
        userId: null,
        version: 2,
        contentVersion: 2,
        snapshotAt: '2026-07-01T00:01:00.000Z',
      }),
      historyEntry({ version: 3, contentVersion: 3, snapshotAt: '2026-07-01T00:02:00.000Z' }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(3);
    expect(sessions[1]?.userId).toBeNull();
    expect(sessions[1]?.entries).toHaveLength(1);
    expect(sessions[0]?.entries).toHaveLength(1);
    expect(sessions[2]?.entries).toHaveLength(1);
  });
});

describe('coalesceParagraphSessions — sealedContentVersion is the contentVersion join key, never version', () => {
  it("session-coalesce: sealedContentVersion is sourced from the last entry's contentVersion, not its paragraph-local version", () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1 }),
      historyEntry({ version: 5, contentVersion: 42, snapshotAt: '2026-07-01T00:05:00.000Z' }),
    ];

    const [session] = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(session?.lastVersion).toBe(5);
    expect(session?.sealedContentVersion).toBe(42);
  });

  it('session-coalesce: null contentVersion last entry is unconditionally unsealed, even when a checkpoint numerically covers its paragraph-local version', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1 }),
      historyEntry({ version: 2, contentVersion: null, snapshotAt: '2026-07-01T00:05:00.000Z' }),
    ];
    // A checkpoint at contentVersion 2 would "cover" this session if sealing
    // ever fell back to comparing against `version` (2) instead of the real
    // (null) contentVersion — asserting null here is what catches that bug.
    const boundaries = [boundary('cp-1', 2)];

    const [session] = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);

    expect(session?.sealedContentVersion).toBeNull();
    expect(session?.sealedByCheckpointId).toBeNull();
  });
});

describe('coalesceParagraphSessions — checkpoint boundary sealing is prev <= N < next, not (prev, next]', () => {
  it('session-coalesce: checkpoint boundary off-by-one — the edit reaching exactly N is sealed (left session), the next edit starts a new (right) session', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 5, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 6, snapshotAt: '2026-07-01T00:01:00.000Z' }),
    ];
    const boundaries = [boundary('cp-1', 5)]; // N === prev.contentVersion exactly

    const sessions = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.sealedContentVersion).toBe(5);
    expect(sessions[0]?.sealedByCheckpointId).toBe('cp-1');
    expect(sessions[1]?.sealedContentVersion).toBe(6);
    expect(sessions[1]?.sealedByCheckpointId).toBeNull(); // no checkpoint has reached CV 6 yet
  });

  it('session-coalesce: a boundary equal to the NEXT entry contentVersion does not split there (N < next is false, an exclusive upper bound)', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 5, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 6, snapshotAt: '2026-07-01T00:01:00.000Z' }),
    ];
    const boundaries = [boundary('cp-1', 6)]; // N === next.contentVersion exactly

    const sessions = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.entries).toHaveLength(2);
  });

  it('sealedByCheckpointId picks the smallest checkpoint contentVersion >= sealedContentVersion, ignoring earlier and later checkpoints', () => {
    const entries = [historyEntry({ version: 1, contentVersion: 5 })];
    const boundaries = [
      boundary('cp-early', 3),
      boundary('cp-sealing', 7),
      boundary('cp-late', 10),
    ];

    const [session] = coalesceParagraphSessions(entries, boundaries, SESSION_WINDOW_MS);

    expect(session?.sealedByCheckpointId).toBe('cp-sealing');
  });

  it('returns null sealedByCheckpointId when sealedContentVersion exceeds every existing checkpoint (still pending)', () => {
    const entries = [historyEntry({ version: 1, contentVersion: 99 })];

    const [session] = coalesceParagraphSessions(entries, [boundary('cp-1', 3)], SESSION_WINDOW_MS);

    expect(session?.sealedByCheckpointId).toBeNull();
  });
});

describe('coalesceParagraphSessions — actor and gap grouping', () => {
  it('groups consecutive same-actor entries within the session window into one session', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:10:00.000Z' }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.entries).toHaveLength(2);
  });

  it('starts a new session when the actor changes, even with no time gap', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({
        userId: 'user-b',
        version: 2,
        contentVersion: 2,
        snapshotAt: '2026-07-01T00:00:00.000Z',
      }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.userId).toBe('user-a');
    expect(sessions[1]?.userId).toBe('user-b');
  });

  it('starts a new session when the gap strictly exceeds sessionWindowMs', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:30:00.001Z' }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(2);
  });

  it('does not split exactly at the sessionWindowMs boundary (gap === window is not "exceeds")', () => {
    const entries = [
      historyEntry({ version: 1, contentVersion: 1, snapshotAt: '2026-07-01T00:00:00.000Z' }),
      historyEntry({ version: 2, contentVersion: 2, snapshotAt: '2026-07-01T00:30:00.000Z' }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(1);
  });
});

describe('coalesceParagraphSessions — beforeText/beforeNodeType derivation', () => {
  it("is null when the session's first entry has op 'insert'", () => {
    const entries = [
      historyEntry({ op: 'insert', version: 1, contentVersion: 1, text: 'created' }),
    ];

    const [session] = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(session?.beforeText).toBeNull();
    expect(session?.beforeNodeType).toBeNull();
    expect(session?.afterText).toBe('created');
  });

  it('is sourced from the immediately preceding entry in the full entries array when the session does not open on insert', () => {
    const entries = [
      historyEntry({
        op: 'insert',
        version: 1,
        contentVersion: 1,
        text: 'original',
        nodeType: 'paragraph',
        snapshotAt: '2026-07-01T00:00:00.000Z',
      }),
      historyEntry({
        userId: 'user-b',
        version: 2,
        contentVersion: 2,
        text: 'edited by b',
        nodeType: 'paragraph',
        snapshotAt: '2026-08-01T00:00:00.000Z',
      }),
    ];

    const sessions = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.beforeText).toBe('original');
    expect(sessions[1]?.beforeNodeType).toBe('paragraph');
    expect(sessions[1]?.afterText).toBe('edited by b');
  });

  it('falls back to null when the first entry overall is not an insert and so has no preceding entry', () => {
    const entries = [historyEntry({ op: 'edit', version: 1, contentVersion: 1, text: 'legacy' })];

    const [session] = coalesceParagraphSessions(entries, [], SESSION_WINDOW_MS);

    expect(session?.beforeText).toBeNull();
    expect(session?.beforeNodeType).toBeNull();
  });
});
