import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lockedObjectMessage } from './paragraphs.js';

vi.mock('../index.js', () => {
  const query = vi.fn();
  const connect = vi.fn();
  return {
    pool: { query, connect },
    DatabaseError: class DatabaseError extends Error {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseError';
      }
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('insertTree — DFS ordering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('inserts each node in DFS order', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const { insertTree } = await import('./paragraphs.js');
    const tree = {
      id: 'tree-1',
      section: '01 00 00',
      title: 'General',
      parts: [
        {
          id: 'part-1',
          type: 'part' as const,
          text: 'GENERAL',
          children: [
            {
              id: 'article-1',
              type: 'article' as const,
              text: 'Summary',
              children: [],
              meta: { source: 'ufgs' as const },
            },
          ],
          meta: { source: 'ufgs' as const },
        },
      ],
    };

    await insertTree(tree, 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(query).mock.calls[0];
    expect(firstCall?.[1]?.[0]).toBe('part-1');
    expect(firstCall?.[1]?.[2]).toBeNull();

    const secondCall = vi.mocked(query).mock.calls[1];
    expect(secondCall?.[1]?.[0]).toBe('article-1');
    expect(secondCall?.[1]?.[2]).toBe('part-1');
  });
});

describe('insertTree — vanish flag', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('sets vanish=true when meta.vanish is set', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const { insertTree } = await import('./paragraphs.js');
    const tree = {
      id: 'tree-2',
      section: '01 00 00',
      title: 'General',
      parts: [
        {
          id: 'note-1',
          type: 'note' as const,
          text: 'Note text',
          children: [],
          meta: { source: 'ufgs' as const, vanish: true },
        },
      ],
    };

    await insertTree(tree, 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(query).mock.calls[0];
    expect(call?.[1]?.[6]).toBe(true);
  });
});

describe('insertTree — empty tree', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('skips INSERT and returns early when tree has no parts', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const { insertTree } = await import('./paragraphs.js');
    const tree = {
      id: 'tree-3',
      section: '01 00 00',
      title: 'Empty',
      parts: [],
    };

    await insertTree(tree, 'spec-uuid-1', pool);

    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});

describe('insertTree — 1-based position', () => {
  const SIMPLE_TREE = {
    id: 'tree-pos',
    section: '01 00 00',
    title: 'General',
    parts: [
      {
        id: 'part-pos-1',
        type: 'part' as const,
        text: 'PART 1',
        children: [],
        meta: { source: 'ufgs' as const },
      },
      {
        id: 'part-pos-2',
        type: 'part' as const,
        text: 'PART 2',
        children: [],
        meta: { source: 'ufgs' as const },
      },
    ],
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses 1-based position for sibling ordering', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { insertTree } = await import('./paragraphs.js');
    await insertTree(SIMPLE_TREE, 'spec-uuid-1', pool);
    const firstInsert = vi
      .mocked(pool.query)
      .mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes('INSERT INTO paragraphs'));
    // position is $6 (index 5 in params array)
    expect(firstInsert?.[1]?.[5]).toBe(1);
  });
});

describe('insertTree — error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('connection lost'));

    const { insertTree } = await import('./paragraphs.js');
    const tree = {
      id: 'tree-4',
      section: '01 00 00',
      title: 'General',
      parts: [
        {
          id: 'part-x',
          type: 'part' as const,
          text: 'GENERAL',
          children: [],
          meta: { source: 'ufgs' as const },
        },
      ],
    };

    await expect(insertTree(tree, 'spec-uuid-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });

  it('includes node id in error message on failure', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('constraint violation'));

    const { insertTree } = await import('./paragraphs.js');
    const tree = {
      id: 'tree-5',
      section: '01 00 00',
      title: 'General',
      parts: [
        {
          id: 'part-uuid-1',
          type: 'part' as const,
          text: 'GENERAL',
          children: [],
          meta: { source: 'ufgs' as const },
        },
      ],
    };

    await expect(insertTree(tree, 'spec-uuid-1', pool)).rejects.toSatisfy(
      (err) => err instanceof DatabaseError && err.message.includes('part-uuid-1')
    );
  });
});

// #519 (ADR-072 decision 3) — applyParagraphUpdate's owner-row split short-circuits
// on a 'locked-object' node BEFORE issuing the text write. Faking only the low-level
// client.query (never assertSpecWritable itself, mirrors paragraph-history.test.ts's
// "fake the client, not the module" approach) exercises the REAL gate + REAL
// fetchUpdateOwnerRow/validateUpdateOwner control flow end-to-end through the
// exported updateParagraphText.
describe('updateParagraphText — locked-object guard (#519, ADR-072 decision 3)', () => {
  const SPEC_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const OBJECT_ID = 'aaaaaaaa-0000-0000-0000-000000000002';

  type FakeRow = Record<string, unknown>;
  type FakeQuery = (
    sql: string,
    params?: readonly unknown[]
  ) => Promise<{ rows: FakeRow[]; rowCount: number }>;

  function fakeUpdateClient(ownerRow: FakeRow): {
    query: ReturnType<typeof vi.fn<FakeQuery>>;
    release: ReturnType<typeof vi.fn>;
  } {
    const query = vi.fn<FakeQuery>((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (sql.includes('FROM specs WHERE id')) {
        return Promise.resolve({
          rows: [{ lifecycle_state: 'draft', external_state: 'editable', content_version: 1 }],
          rowCount: 1,
        });
      }
      if (sql.includes('FROM paragraphs WHERE id = $1') && sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [ownerRow], rowCount: 1 });
      }
      return Promise.reject(new Error(`fakeUpdateClient: unexpected query: ${sql}`));
    });
    return { query, release: vi.fn() };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('short-circuits on an object row before any UPDATE — the text write is never issued', async () => {
    const { pool } = await import('../index.js');
    const client = fakeUpdateClient({
      spec_id: SPEC_ID,
      node_type: 'object',
      base_version: 3,
      parent_id: null,
    });
    vi.mocked(pool.connect).mockResolvedValueOnce(client as never);

    const { updateParagraphText } = await import('./paragraphs.js');
    const result = await updateParagraphText(SPEC_ID, OBJECT_ID, 'attempted direct rewrite');

    expect(result).toEqual({ status: 'locked-object', nodeType: 'object' });
    expect(
      client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE paragraphs SET text'))
    ).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false);
  });
});

// #519 review finding: REST (src/api/paragraphs.ts) and MCP (src/mcp/paragraph-handlers.ts)
// both render this exact string for a locked-object rejection. Pinning it here means a
// future wording change can only happen in one place, and both surfaces' integration
// tests assert their live output equals this same function's return value — so the two
// surfaces are provably identical, not just each individually plausible.
describe('lockedObjectMessage (#519 review — REST/MCP message parity)', () => {
  it('names the offending node type and points the caller at objectText', () => {
    expect(lockedObjectMessage('object')).toBe(
      'node type "object" is locked and cannot be edited directly — edit its objectText child instead'
    );
  });

  it('interpolates whatever nodeType it is given, not a hardcoded "object"', () => {
    expect(lockedObjectMessage('objectText')).toContain('node type "objectText"');
  });
});
