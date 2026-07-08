// src/mcp/hierarchy-report-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSpecTree: vi.fn(),
  getSpecSource: vi.fn(),
}));

vi.mock('../lib/hierarchy-report.js', () => ({
  buildHierarchyReport: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const SPEC_ID = '10000000-0000-4000-8000-000000000001';
const UNKNOWN_SPEC_ID = '00000000-0000-4000-8000-000000000000';

const TREE = { id: SPEC_ID, section: '27 21 00', title: 'Cabling', parts: [] };

const REPORT = {
  counts: { scored: 2, unscored: 0, belowThreshold: 1 },
  paragraphs: [
    {
      nodeId: 'p2',
      nodeType: 'article' as const,
      ilvl: 1,
      label: '1.2',
      preview: 'Worst paragraph',
      confidence: 0.2,
      signalUsed: 3 as const,
      agreed: [3 as const],
      evidence: ['document order'],
    },
    {
      nodeId: 'p1',
      nodeType: 'part' as const,
      ilvl: 0,
      label: 'PART 1',
      preview: 'Best paragraph',
      confidence: 0.9,
      signalUsed: 1 as const,
      agreed: [1 as const, 2 as const],
      evidence: ['numbering.xml'],
    },
  ],
};

describe('handleGetHierarchyReport', () => {
  it('returns the hierarchy report as JSON content for a known spec', async () => {
    const db = await import('../db/index.js');
    const hierarchyReport = await import('../lib/hierarchy-report.js');
    vi.mocked(db.getSpecTree).mockResolvedValueOnce({ tree: TREE, references: [] });
    vi.mocked(db.getSpecSource).mockResolvedValueOnce('arcat');
    vi.mocked(hierarchyReport.buildHierarchyReport).mockReturnValueOnce(REPORT);
    const { handleGetHierarchyReport } = await import('./hierarchy-report-tools.js');

    const result = await handleGetHierarchyReport({ specId: SPEC_ID });

    expect(result).not.toHaveProperty('isError');
    expect(vi.mocked(db.getSpecTree)).toHaveBeenCalledWith(SPEC_ID);
    expect(vi.mocked(db.getSpecSource)).toHaveBeenCalledWith(SPEC_ID);
    expect(vi.mocked(hierarchyReport.buildHierarchyReport)).toHaveBeenCalledWith(TREE, 'arcat');
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual(REPORT);
  });

  it('returns isError (never throws) for an unknown spec', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecTree).mockResolvedValueOnce(null);
    const { handleGetHierarchyReport } = await import('./hierarchy-report-tools.js');

    const result = await handleGetHierarchyReport({ specId: UNKNOWN_SPEC_ID });

    expect(result).toMatchObject({ isError: true });
    const text = (result as { isError: true; content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain(UNKNOWN_SPEC_ID);
    expect(vi.mocked(db.getSpecSource)).not.toHaveBeenCalled();
  });

  it('returns isError (never throws) for a syntactically invalid specId, skipping the DB', async () => {
    const db = await import('../db/index.js');
    const { handleGetHierarchyReport } = await import('./hierarchy-report-tools.js');

    const result = await handleGetHierarchyReport({ specId: 'not-a-uuid' });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.getSpecTree)).not.toHaveBeenCalled();
  });

  it('returns isError (never throws) when the DB call rejects', async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getSpecTree).mockRejectedValueOnce(new Error('db down'));
    const { handleGetHierarchyReport } = await import('./hierarchy-report-tools.js');

    const result = await handleGetHierarchyReport({ specId: SPEC_ID });

    expect(result).toMatchObject({ isError: true });
  });
});
