import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirror clients.test.ts/users.test.ts: mock the DatabaseError class the module-under-test
// sees (paragraph-history.ts imports it from '../index.js') so instanceof checks line up,
// and mock resolveOrCreateUserByLabel (paragraph-history.ts imports it directly from the
// sibling ./users.js, per the established cross-sibling-query convention).
class MockDatabaseError extends Error {
  cause?: unknown;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DatabaseError';
    this.cause = options?.cause;
  }
}

const resolveOrCreateUserByLabel = vi.fn();

vi.mock('../errors.js', () => ({ DatabaseError: MockDatabaseError }));
vi.mock('../index.js', () => ({
  DatabaseError: MockDatabaseError,
  pool: { query: vi.fn() },
}));
vi.mock('./users.js', () => ({ resolveOrCreateUserByLabel }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

type QueryParams = readonly unknown[];
type FakeQuery = (
  sql: string,
  params?: QueryParams
) => Promise<{ rows: unknown[]; rowCount: number }>;

// Typed explicitly (not `vi.fn()`'s default `any`) so `.mock.calls[n]?.[1]?.[k]` below stays
// `unknown`, never `any` — satisfies @typescript-eslint/no-unsafe-* without a blanket cast.
function fakeClient(): { query: ReturnType<typeof vi.fn<FakeQuery>> } {
  return { query: vi.fn<FakeQuery>() };
}

const baseInput = {
  paragraphId: 'p1',
  specId: 's1',
  version: 2,
  text: 'hello',
  nodeType: 'pr1',
  op: 'edit' as const,
  contentVersion: 3,
  userId: 'u1',
};

describe('recordParagraphHistory', () => {
  it('is idempotent on (paragraph_id, version): issues ON CONFLICT (paragraph_id, version) DO NOTHING', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { recordParagraphHistory } = await import('./paragraph-history.js');

    await recordParagraphHistory(client as never, baseInput);
    await recordParagraphHistory(client as never, baseInput);

    expect(client.query).toHaveBeenCalledTimes(2);
    for (const call of client.query.mock.calls) {
      expect(call[0]).toContain('ON CONFLICT (paragraph_id, version) DO NOTHING');
    }
  });

  it('passes every column in the documented order, defaulting an omitted payload to null', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { recordParagraphHistory } = await import('./paragraph-history.js');

    await recordParagraphHistory(client as never, baseInput);

    expect(client.query.mock.calls[0]?.[1]).toEqual([
      'p1',
      's1',
      2,
      'hello',
      'pr1',
      'edit',
      3,
      'u1',
      'null',
    ]);
  });

  it('serializes a structured payload as JSON', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { recordParagraphHistory } = await import('./paragraph-history.js');

    await recordParagraphHistory(client as never, {
      ...baseInput,
      op: 'insert',
      payload: { kind: 'insert', parentId: 'parent-1', position: 4 },
    });

    const payloadArg = client.query.mock.calls[0]?.[1]?.[8];
    expect(JSON.parse(payloadArg as string)).toEqual({
      kind: 'insert',
      parentId: 'parent-1',
      position: 4,
    });
  });

  it('serializes an explicit null payload (edit/remove/restore ops) as JSON null', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const { recordParagraphHistory } = await import('./paragraph-history.js');

    await recordParagraphHistory(client as never, { ...baseInput, payload: null });

    expect(client.query.mock.calls[0]?.[1]?.[8]).toBe('null');
  });

  it('wraps a raw db error as DatabaseError with the pg cause chained', async () => {
    const client = fakeClient();
    const pgErr = new Error('db down');
    client.query.mockRejectedValueOnce(pgErr);
    const { recordParagraphHistory } = await import('./paragraph-history.js');
    const { DatabaseError } = await import('../index.js');

    const err = await recordParagraphHistory(client as never, baseInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect((err as { cause?: unknown }).cause).toBe(pgErr);
  });
});

describe('resolveActorUserId', () => {
  it('resolves the supplied actorLabel through resolveOrCreateUserByLabel', async () => {
    resolveOrCreateUserByLabel.mockResolvedValueOnce({ id: 'u-alice', label: 'alice' });
    const client = fakeClient();
    const { resolveActorUserId } = await import('./paragraph-history.js');

    const userId = await resolveActorUserId(client as never, 'alice');

    expect(userId).toBe('u-alice');
    expect(resolveOrCreateUserByLabel).toHaveBeenCalledWith('alice', client);
  });

  it('falls back to SYSTEM_ACTOR_LABEL when actorLabel is omitted — every row resolves to a real user_id, never left null at the app layer', async () => {
    resolveOrCreateUserByLabel.mockResolvedValueOnce({
      id: 'u-system',
      label: 'system:unattributed',
    });
    const client = fakeClient();
    const { resolveActorUserId, SYSTEM_ACTOR_LABEL } = await import('./paragraph-history.js');

    const userId = await resolveActorUserId(client as never, undefined);

    expect(userId).toBe('u-system');
    expect(SYSTEM_ACTOR_LABEL).toBe('system:unattributed');
    expect(resolveOrCreateUserByLabel).toHaveBeenCalledWith(SYSTEM_ACTOR_LABEL, client);
  });

  it('propagates a resolveOrCreateUserByLabel failure uncaught (already a typed DatabaseError)', async () => {
    const { DatabaseError } = await import('../index.js');
    resolveOrCreateUserByLabel.mockRejectedValueOnce(new DatabaseError('upsert failed'));
    const client = fakeClient();
    const { resolveActorUserId } = await import('./paragraph-history.js');

    await expect(resolveActorUserId(client as never, 'alice')).rejects.toBeInstanceOf(
      DatabaseError
    );
  });
});

describe('resolveHistoryContext', () => {
  it('stamps contentVersion as preBumpContentVersion + 1, matching the post-bump specs.content_version', async () => {
    resolveOrCreateUserByLabel.mockResolvedValueOnce({ id: 'u-alice', label: 'alice' });
    const client = fakeClient();
    const { resolveHistoryContext } = await import('./paragraph-history.js');

    const ctx = await resolveHistoryContext(client as never, 5, 'alice');

    expect(ctx.contentVersion).toBe(6);
  });

  it('bundles the resolved userId from resolveActorUserId (SYSTEM_ACTOR_LABEL fallback included)', async () => {
    resolveOrCreateUserByLabel.mockResolvedValueOnce({
      id: 'u-system',
      label: 'system:unattributed',
    });
    const client = fakeClient();
    const { resolveHistoryContext } = await import('./paragraph-history.js');

    const ctx = await resolveHistoryContext(client as never, 0, undefined);

    expect(ctx).toEqual({ contentVersion: 1, userId: 'u-system' });
  });
});

describe('lazyHistoryContext', () => {
  it('resolves once and memoizes — repeated calls return the same context, one actor upsert', async () => {
    resolveOrCreateUserByLabel.mockResolvedValueOnce({ id: 'u-alice', label: 'alice' });
    const client = fakeClient();
    const { lazyHistoryContext } = await import('./paragraph-history.js');

    const getCtx = lazyHistoryContext(client as never, 5, 'alice');
    const [ctx1, ctx2] = await Promise.all([getCtx(), getCtx()]);

    expect(ctx1).toBe(ctx2); // same object — resolved once, then memoized
    expect(ctx1).toEqual({ contentVersion: 6, userId: 'u-alice' });
    expect(resolveOrCreateUserByLabel).toHaveBeenCalledTimes(1);
  });

  it('never upserts the actor when the getter is never called — a write that no-ops resolves nothing', async () => {
    const client = fakeClient();
    const { lazyHistoryContext } = await import('./paragraph-history.js');

    // Build the resolver but never invoke it — the deferral's whole point: a
    // merge that applies zero changes must not upsert a users row for actorLabel.
    lazyHistoryContext(client as never, 5, 'alice');

    expect(resolveOrCreateUserByLabel).not.toHaveBeenCalled();
  });
});

describe('PARAGRAPH_HISTORY_OPS', () => {
  it("mirrors migration 055's paragraph_versions_op_check CHECK constraint exactly", async () => {
    const { PARAGRAPH_HISTORY_OPS } = await import('./paragraph-history.js');
    expect(PARAGRAPH_HISTORY_OPS).toEqual([
      'edit',
      'insert',
      'remove',
      'restore',
      'merge',
      'accept-note',
      'restructure',
      'acknowledge',
      'unacknowledge',
      'close-comment',
      'reopen-comment',
    ]);
  });
});
