import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index.js', () => {
  const query = vi.fn();
  return {
    pool: { query },
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
