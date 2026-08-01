import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  pool: {},
  searchParagraphs: vi.fn(),
  listSpecSections: vi.fn(),
  getSpecTree: vi.fn(),
  getSpecStyleSource: vi.fn(),
  getOnboardingStatus: vi.fn(),
  getSpecWithdrawnAt: vi.fn(),
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
  resolveSpecHeaderFooterContext: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useRealTimers();
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

describe('handleGetSpec', () => {
  it('get_spec: withdrawn master surfaces withdrawnAt (ADR-030 tombstone)', async () => {
    const db = await import('../db/index.js');
    const { handleGetSpec } = await import('./handlers.js');

    vi.mocked(db.getSpecTree).mockResolvedValueOnce(STUB_SPEC_TREE as never);
    vi.mocked(db.getSpecStyleSource).mockResolvedValueOnce(null);
    vi.mocked(db.getOnboardingStatus).mockResolvedValueOnce('active');
    vi.mocked(db.getSpecWithdrawnAt).mockResolvedValueOnce('2026-06-27T00:00:00.000Z');

    const result = await handleGetSpec({ specId: FAKE_SPEC_ID });

    expect(result).not.toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { withdrawnAt: string | null };
    expect(parsed.withdrawnAt).toBe('2026-06-27T00:00:00.000Z');
    expect(vi.mocked(db.getSpecWithdrawnAt)).toHaveBeenCalledWith(FAKE_SPEC_ID);
  });

  it('get_spec: active master surfaces withdrawnAt=null', async () => {
    const db = await import('../db/index.js');
    const { handleGetSpec } = await import('./handlers.js');

    vi.mocked(db.getSpecTree).mockResolvedValueOnce(STUB_SPEC_TREE as never);
    vi.mocked(db.getSpecStyleSource).mockResolvedValueOnce(null);
    vi.mocked(db.getOnboardingStatus).mockResolvedValueOnce('active');
    vi.mocked(db.getSpecWithdrawnAt).mockResolvedValueOnce(null);

    const result = await handleGetSpec({ specId: FAKE_SPEC_ID });

    expect(result).not.toMatchObject({ isError: true });
    const text = (result as { content: { text: string }[] }).content[0]?.text ?? '';
    const parsed = JSON.parse(text) as { withdrawnAt: string | null };
    expect(parsed.withdrawnAt).toBeNull();
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

// #304 review finding: resolveHeaderFooterInput is generate_docx's inline
// mirror of src/api/generate-header-footer.ts's buildHeaderFooterOptions
// (deliberately duplicated across the api/↔mcp/ module boundary — see that
// function's own comment). buildHeaderFooterOptions has a dedicated I2/I5/I9
// unit suite (src/api/generate-header-footer.test.ts); this file's
// server.integration.test.ts coverage re-fetches fresh rows from Postgres on
// every call, so it can never observe a mutation of the resolved context —
// these unit tests close that gap directly against the exported function.
describe('resolveHeaderFooterInput', () => {
  const COMPOSITION = { header: { left: { content: [] } } };

  it('#304 I2: null context (orphan/ambiguous/unconfigured spec) resolves to undefined', async () => {
    const db = await import('../db/index.js');
    const { resolveHeaderFooterInput } = await import('./handlers.js');
    vi.mocked(db.resolveSpecHeaderFooterContext).mockResolvedValueOnce(null);

    const result = await resolveHeaderFooterInput(FAKE_SPEC_ID);

    expect(result).toBeUndefined();
    expect(vi.mocked(db.resolveSpecHeaderFooterContext)).toHaveBeenCalledWith(
      FAKE_SPEC_ID,
      db.pool
    );
  });

  it('#304 I5: never mutates the object resolveSpecHeaderFooterContext returned', async () => {
    const db = await import('../db/index.js');
    const { resolveHeaderFooterInput } = await import('./handlers.js');
    const fieldValues = Object.freeze({ projectName: 'Acme HQ' });
    const context = Object.freeze({ composition: COMPOSITION, fieldValues });
    vi.mocked(db.resolveSpecHeaderFooterContext).mockResolvedValueOnce(context);

    await expect(resolveHeaderFooterInput(FAKE_SPEC_ID)).resolves.toBeDefined();

    expect(context.fieldValues).toEqual({ projectName: 'Acme HQ' });
    expect(context).toEqual({ composition: COMPOSITION, fieldValues: { projectName: 'Acme HQ' } });
  });

  it('#304 I9: stamps today, formatted YYYY-MM-DD, alongside the sourced fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T00:00:00Z'));
    const db = await import('../db/index.js');
    const { resolveHeaderFooterInput } = await import('./handlers.js');
    vi.mocked(db.resolveSpecHeaderFooterContext).mockResolvedValueOnce({
      composition: COMPOSITION,
      fieldValues: { projectName: 'Acme HQ' },
    });

    const result = await resolveHeaderFooterInput(FAKE_SPEC_ID);

    expect(result).toEqual({
      composition: COMPOSITION,
      current: { date: '2026-01-05', projectName: 'Acme HQ' },
    });
    vi.useRealTimers();
  });
});
