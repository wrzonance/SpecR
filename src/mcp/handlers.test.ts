import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  pool: {},
  searchParagraphs: vi.fn(),
  listSpecSections: vi.fn(),
  getSpecTree: vi.fn(),
  getParagraphWithAncestors: vi.fn(),
  persistParsedSpec: vi.fn(),
  lookupSpecSectionTitle: vi.fn(),
  getSpecLineage: vi.fn(),
  findProjectById: vi.fn(),
  findProjectSpecIdsBySection: vi.fn(),
  getInboundReferences: vi.fn(),
  getOutboundReferences: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('handleGetReferences', () => {
  it('rejects malformed section before any DB call', async () => {
    const db = await import('../db/index.js');
    const { handleGetReferences } = await import('./handlers.js');

    const result = await handleGetReferences({
      projectId: '10000000-0000-4000-8000-000000000001',
      section: '9 91 00',
      direction: undefined,
    });

    expect(result).toMatchObject({ isError: true });
    expect(vi.mocked(db.findProjectById)).not.toHaveBeenCalled();
    expect(vi.mocked(db.getInboundReferences)).not.toHaveBeenCalled();
    expect(vi.mocked(db.getOutboundReferences)).not.toHaveBeenCalled();
  });
});
