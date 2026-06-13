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

describe('insertRefs — empty input', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns early without querying when refs is empty', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;

    const { insertRefs } = await import('./refs.js');
    await insertRefs([], 'spec-uuid-1', pool);

    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });
});

describe('insertRefs — section refs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('SELECTs target_spec_id for section refs then INSERTs', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: 'target-spec-42' }] } as never);
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);

    const ref = {
      sourceNodeId: 'node-1',
      targetType: 'section' as const,
      targetSpecSection: '03 30 00',
      referenceText: 'See section 03 30 00',
    };
    const { insertRefs } = await import('./refs.js');
    await insertRefs([ref], 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const selectCall = vi.mocked(query).mock.calls[0];
    expect(selectCall?.[0]).toContain('SELECT id FROM specs');
    expect(selectCall?.[1]?.[0]).toBe('03 30 00');

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall?.[1]?.[4]).toBe('target-spec-42');
  });

  it('sets target_spec_id null when section ref has no matching spec', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);

    const ref = {
      sourceNodeId: 'node-2',
      targetType: 'section' as const,
      targetSpecSection: '99 99 99',
      referenceText: 'Unknown section',
    };
    const { insertRefs } = await import('./refs.js');
    await insertRefs([ref], 'spec-uuid-1', pool);

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall?.[1]?.[4]).toBeNull();
  });
});

describe('insertRefs — standard refs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('skips SELECT for standard refs and inserts directly', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);

    const ref = {
      sourceNodeId: 'node-3',
      targetType: 'standard' as const,
      standardCode: 'ASTM C150',
      referenceText: 'ASTM C150 Standard',
    };
    const { insertRefs } = await import('./refs.js');
    await insertRefs([ref], 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const insertCall = vi.mocked(query).mock.calls[0];
    expect(insertCall?.[0]).toContain('INSERT INTO spec_references');
    expect(insertCall?.[1]?.[2]).toBe('standard');
    expect(insertCall?.[1]?.[5]).toBe('ASTM C150');
  });

  it('inserts multiple refs in order', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValue({ rows: [] } as never);

    const refs = [
      {
        sourceNodeId: 'node-a',
        targetType: 'standard' as const,
        standardCode: 'ACI 318',
        referenceText: 'ACI 318',
      },
      {
        sourceNodeId: 'node-b',
        targetType: 'standard' as const,
        standardCode: 'ASTM A36',
        referenceText: 'ASTM A36',
      },
    ];
    const { insertRefs } = await import('./refs.js');
    await insertRefs(refs, 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(query).mock.calls[0]?.[1]?.[5]).toBe('ACI 318');
    expect(vi.mocked(query).mock.calls[1]?.[1]?.[5]).toBe('ASTM A36');
  });
});

describe('insertRefs — error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('timeout'));

    const ref = {
      sourceNodeId: 'node-x',
      targetType: 'standard' as const,
      standardCode: 'ISO 9001',
      referenceText: 'ISO 9001',
    };
    const { insertRefs } = await import('./refs.js');
    await expect(insertRefs([ref], 'spec-uuid-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});

describe('reference traversal queries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('getInboundReferences maps rows and scopes by project + target section', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        {
          source_spec_id: 'spec-1',
          source_section: '03 30 00',
          source_title: 'Concrete',
          source_paragraph_id: 'para-1',
          reference_text: 'See Section 09 91 00',
          target_spec_id: 'target-1',
          is_broken: false,
        },
      ],
    } as never);

    const { getInboundReferences } = await import('./refs.js');
    const result = await getInboundReferences('09 91 00', 'project-1', pool);

    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['09 91 00', 'project-1']);
    expect(result).toEqual([
      {
        sourceSpecId: 'spec-1',
        sourceSection: '03 30 00',
        sourceTitle: 'Concrete',
        sourceParagraphId: 'para-1',
        referenceText: 'See Section 09 91 00',
        isResolved: true,
        isBroken: false,
      },
    ]);
  });

  it('getOutboundReferences maps unresolved refs and scopes by project + source spec', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        {
          source_spec_id: 'spec-1',
          reference_text: 'See Section 99 99 99',
          target_spec_section: '99 99 99',
          target_spec_id: null,
          is_broken: true,
        },
      ],
    } as never);

    const { getOutboundReferences } = await import('./refs.js');
    const result = await getOutboundReferences('spec-1', 'project-1', pool);

    expect(vi.mocked(query).mock.calls[0]?.[1]).toEqual(['spec-1', 'project-1']);
    expect(result).toEqual([
      {
        sourceSpecId: 'spec-1',
        referenceText: 'See Section 99 99 99',
        targetSection: '99 99 99',
        targetSpecId: null,
        isResolved: false,
        isBroken: true,
      },
    ]);
  });

  it('findProjectSpecIdsBySection returns ordered ids from the query result', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ id: 'spec-a' }, { id: 'spec-b' }],
    } as never);

    const { findProjectSpecIdsBySection } = await import('./refs.js');
    await expect(findProjectSpecIdsBySection('03 30 00', 'project-1', pool)).resolves.toEqual([
      'spec-a',
      'spec-b',
    ]);
  });

  it('isSpecInProject returns false when no membership row exists', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ exists: false }] } as never);

    const { isSpecInProject } = await import('./refs.js');
    await expect(isSpecInProject('spec-1', 'project-1', pool)).resolves.toBe(false);
  });
});
