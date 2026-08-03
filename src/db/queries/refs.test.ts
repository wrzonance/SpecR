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

  it('resolves target_spec_id via one batched SELECT then issues one INSERT (2 total calls)', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'target-spec-42', section: '03 30 00' }],
    } as never);
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
    expect(selectCall?.[0]).toContain('SELECT id, section FROM specs');
    expect(selectCall?.[1]?.[0]).toEqual(['03 30 00']);

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall?.[0]).toContain('INSERT INTO spec_references');
    expect(insertCall?.[1]?.[4]).toBe('target-spec-42');
  });

  it('resolves multiple distinct sections in one SELECT (not one per ref)', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        { id: 'target-1', section: '03 30 00' },
        { id: 'target-2', section: '09 91 00' },
      ],
    } as never);
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);

    const refs = [
      {
        sourceNodeId: 'node-1',
        targetType: 'section' as const,
        targetSpecSection: '03 30 00',
        referenceText: 'See section 03 30 00',
      },
      {
        sourceNodeId: 'node-2',
        targetType: 'section' as const,
        targetSpecSection: '09 91 00',
        referenceText: 'See section 09 91 00',
      },
      // A repeated section must not add a second SELECT param.
      {
        sourceNodeId: 'node-3',
        targetType: 'section' as const,
        targetSpecSection: '03 30 00',
        referenceText: 'See section 03 30 00 again',
      },
    ];
    const { insertRefs } = await import('./refs.js');
    await insertRefs(refs, 'spec-uuid-1', pool);

    expect(vi.mocked(query)).toHaveBeenCalledTimes(2);
    const selectCall = vi.mocked(query).mock.calls[0];
    expect(selectCall?.[1]?.[0]).toEqual(['03 30 00', '09 91 00']);
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

  // `specs.section` is only unique per (section, source, library_id) / (section,
  // project_id) — migration 016 — so one section can match several specs. The
  // pre-batch code took `SELECT id … LIMIT 1`, i.e. the FIRST row. A last-wins
  // map would repoint target_spec_id at the LAST duplicate instead, silently
  // changing which spec a ref resolves to.
  it('insertRefs: duplicate section — resolves to the FIRST matching spec, not the last', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        { id: 'spec-first', section: '03 30 00' },
        { id: 'spec-second', section: '03 30 00' },
        { id: 'spec-third', section: '03 30 00' },
      ],
    } as never);
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);

    const ref = {
      sourceNodeId: 'node-dup',
      targetType: 'section' as const,
      targetSpecSection: '03 30 00',
      referenceText: 'See section 03 30 00',
    };
    const { insertRefs } = await import('./refs.js');
    await insertRefs([ref], 'spec-uuid-1', pool);

    const insertCall = vi.mocked(query).mock.calls[1];
    expect(insertCall?.[1]?.[4]).toBe('spec-first');
  });
});

describe('insertRefs — standard refs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('skips the SELECT for standard-only refs and issues one batched INSERT', async () => {
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

  it('inserts multiple refs in one batched INSERT, params in row-major order preserved', async () => {
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

    // One batched INSERT, not one per ref.
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
    const params = vi.mocked(query).mock.calls[0]?.[1] ?? [];
    // 7 columns/row: standard_code sits at column index 5 of each row's slice.
    expect(params[5]).toBe('ACI 318');
    expect(params[12]).toBe('ASTM A36');
  });
});

describe('insertRefs — error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('wraps a failed batched INSERT in DatabaseError with a chunk-identified message', async () => {
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
    await expect(insertRefs([ref], 'spec-uuid-1', pool)).rejects.toSatisfy(
      (err) =>
        err instanceof DatabaseError &&
        err.message.includes('insertRefs: failed to insert reference batch 1/1') &&
        err.message.includes('node-x')
    );
  });

  it('wraps a failed fetchSectionSpecIds SELECT in DatabaseError without attempting the INSERT', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('connection reset'));

    const ref = {
      sourceNodeId: 'node-y',
      targetType: 'section' as const,
      targetSpecSection: '03 30 00',
      referenceText: 'See section 03 30 00',
    };
    const { insertRefs } = await import('./refs.js');
    await expect(insertRefs([ref], 'spec-uuid-1', pool)).rejects.toBeInstanceOf(DatabaseError);
    expect(vi.mocked(query)).toHaveBeenCalledTimes(1);
  });

  // The batched SELECT resolves every section at once, so its failure message
  // must name the sections it was resolving — otherwise a resolution failure
  // reports no identity at all, unlike the per-ref code it replaced.
  it('insertRefs: section-resolution failure names the sections it was resolving', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockRejectedValueOnce(new Error('connection reset'));

    const refs = [
      {
        sourceNodeId: 'node-y',
        targetType: 'section' as const,
        targetSpecSection: '03 30 00',
        referenceText: 'See 03 30 00',
      },
      {
        sourceNodeId: 'node-z',
        targetType: 'section' as const,
        targetSpecSection: '09 91 26',
        referenceText: 'See 09 91 26',
      },
    ];
    const { insertRefs } = await import('./refs.js');
    await expect(insertRefs(refs, 'spec-uuid-1', pool)).rejects.toSatisfy(
      (err) =>
        err instanceof DatabaseError &&
        err.message.includes('2 section(s)') &&
        err.message.includes('03 30 00') &&
        err.message.includes('09 91 26')
    );
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
          source_paragraph_id: 'para-9',
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
        sourceParagraphId: 'para-9',
        referenceText: 'See Section 99 99 99',
        targetSection: '99 99 99',
        targetSpecId: null,
        isResolved: false,
        isBroken: true,
      },
    ]);
  });

  it('outbound references carry sourceParagraphId (was empty → demo removed-citation flow disarmed)', async () => {
    const { pool } = await import('../index.js');
    const { query } = pool;
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        {
          source_spec_id: 'spec-1',
          source_paragraph_id: 'para-7',
          reference_text: 'See Section 03 30 00',
          target_spec_section: '03 30 00',
          target_spec_id: 'target-1',
          is_broken: false,
        },
      ],
    } as never);

    const { getOutboundReferences } = await import('./refs.js');
    const result = await getOutboundReferences('spec-1', 'project-1', pool);

    // The query must SELECT the paragraph locator so the client can build a
    // per-paragraph reference index (tree.js buildSheetCtx → refsByParagraph).
    expect(vi.mocked(query).mock.calls[0]?.[0]).toContain('sr.source_paragraph_id');
    expect(result[0]?.sourceParagraphId).toBe('para-7');
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
