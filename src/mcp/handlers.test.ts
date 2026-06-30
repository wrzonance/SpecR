import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  pool: {},
  searchParagraphs: vi.fn(),
  listSpecSections: vi.fn(),
  getSpecTree: vi.fn(),
  getSpecStyleSource: vi.fn(),
  getParagraphWithAncestors: vi.fn(),
  persistParsedSpec: vi.fn(),
  lookupSpecSectionTitle: vi.fn(),
  getSpecLineage: vi.fn(),
  findProjectById: vi.fn(),
  findProjectSpecIdsBySection: vi.fn(),
  getInboundReferences: vi.fn(),
  getOutboundReferences: vi.fn(),
  listProjects: vi.fn(),
  getEffectiveNumberingProfile: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

const FAKE_SPEC_ID = '10000000-0000-4000-8000-000000000001';
const UNKNOWN_SPEC_ID = '00000000-0000-0000-0000-000000000000';

const STUB_SPEC_TREE = {
  tree: { id: FAKE_SPEC_ID, section: '09 91 00', title: 'Test Spec', parts: [] },
  refs: [],
};

const STUB_PROFILE = {
  tiers: { part: { numberStyle: 'integer', maxCount: 3 } },
  numbering: [],
  styleLadder: [],
};

describe('handleGetNumberingProfile', () => {
  it('returns effective profile JSON for a known spec', async () => {
    const db = await import('../db/index.js');
    const { handleGetNumberingProfile } = await import('./handlers.js');

    vi.mocked(db.getSpecTree).mockResolvedValueOnce(STUB_SPEC_TREE as never);
    vi.mocked(db.getEffectiveNumberingProfile).mockResolvedValueOnce(STUB_PROFILE as never);

    const result = await handleGetNumberingProfile({ specId: FAKE_SPEC_ID });

    expect(result).not.toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(JSON.parse(text)).toEqual(STUB_PROFILE);
    expect(vi.mocked(db.getEffectiveNumberingProfile)).toHaveBeenCalledWith(FAKE_SPEC_ID);
  });

  it('returns isError for an unknown spec via a single effective-profile lookup (null)', async () => {
    const db = await import('../db/index.js');
    const { handleGetNumberingProfile } = await import('./handlers.js');

    vi.mocked(db.getEffectiveNumberingProfile).mockResolvedValueOnce(null);

    const result = await handleGetNumberingProfile({ specId: UNKNOWN_SPEC_ID });

    expect(result).toMatchObject({ isError: true });
    const text = (result as { isError: true; content: { text: string }[] }).content[0]?.text ?? '';
    expect(text).toContain(UNKNOWN_SPEC_ID);
    expect(vi.mocked(db.getEffectiveNumberingProfile)).toHaveBeenCalledWith(UNKNOWN_SPEC_ID);
  });
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
