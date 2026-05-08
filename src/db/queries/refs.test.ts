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
    await insertRefs('spec-1', []);

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

    const { insertRefs } = await import('./refs.js');
    await insertRefs('spec-1', [
      {
        sourceNodeId: 'node-1',
        targetType: 'section',
        targetSpecSection: '03 30 00',
        referenceText: 'See section 03 30 00',
      },
    ]);

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

    const { insertRefs } = await import('./refs.js');
    await insertRefs('spec-1', [
      {
        sourceNodeId: 'node-2',
        targetType: 'section',
        targetSpecSection: '99 99 99',
        referenceText: 'Unknown section',
      },
    ]);

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

    const { insertRefs } = await import('./refs.js');
    await insertRefs('spec-1', [
      {
        sourceNodeId: 'node-3',
        targetType: 'standard',
        standardCode: 'ASTM C150',
        referenceText: 'ASTM C150 Standard',
      },
    ]);

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

    const { insertRefs } = await import('./refs.js');
    await insertRefs('spec-1', [
      {
        sourceNodeId: 'node-a',
        targetType: 'standard',
        standardCode: 'ACI 318',
        referenceText: 'ACI 318',
      },
      {
        sourceNodeId: 'node-b',
        targetType: 'standard',
        standardCode: 'ASTM A36',
        referenceText: 'ASTM A36',
      },
    ]);

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

    const { insertRefs } = await import('./refs.js');
    await expect(
      insertRefs('spec-1', [
        {
          sourceNodeId: 'node-x',
          targetType: 'standard',
          standardCode: 'ISO 9001',
          referenceText: 'ISO 9001',
        },
      ])
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
