import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// buildParseResponse is a pure builder with no DB/env touch-points, but the
// module it lives in (parse-document-handler.ts) transitively imports
// db/index.js → env.ts, which validates process.env and process.exit(1)s at
// module scope. Set the minimum env before any dynamic import, matching the
// pattern in src/lib/logger.test.ts.
beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
});

// #567 — handleParseDocument's own regression suite mocks its DB and parser
// boundaries (mirrors src/api/parse.test.ts's mocking shape for the same
// pipeline on the REST side) so these tests pin the handler's wiring —
// override precedence, the shared allowlist, and the 'unknown'-overwrite
// fix — without touching a real database or the real DOCX/PDF/SEC parsers.
vi.mock('../parser/index.js', () => ({
  parse: vi.fn(),
  assertDocxSafe: vi.fn().mockResolvedValue(undefined),
  assertSecSafe: vi.fn().mockReturnValue('decoded .sec text'),
  assertPdfSafe: vi.fn(),
}));
vi.mock('../db/index.js', () => ({
  persistParsedSpec: vi.fn().mockResolvedValue('spec-id-1'),
  lookupSpecSectionTitle: vi.fn().mockResolvedValue(null),
  getNumberingProfile: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('../lib/log-context.js', () => ({
  parseLog: vi.fn(() => ({ warn: vi.fn(), error: vi.fn() })),
  logParseWarnings: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const FAKE_PROFILE_ID = '30000000-0000-4000-8000-000000000001';

function b64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}

const BASE_TREE = { id: 'r', section: '09 91 23', title: 'Painting', parts: [] };
const METADATA_INFERENCE = {
  method: 'metadata' as const,
  confidence: 'high' as const,
  inferredSection: '09 91 23',
  inferredTitle: 'Painting',
  titleMatch: 'unknown' as const,
};

describe('buildParseResponse', () => {
  it('includes warnings when the tree carries them', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = {
      id: 'r',
      section: '09 91 23',
      title: 't',
      parts: [],
      warnings: [{ type: 'unusual-part-count' as const }],
    };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      3
    );
    expect(r['warnings']).toHaveLength(1);
    expect(r['sectionInference']).toBeUndefined();
  });

  it('omits warnings when the tree has none', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      0
    );
    expect(r['warnings']).toBeUndefined();
  });

  it('omits warnings when the tree carries an empty warnings array', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [], warnings: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'metadata',
        confidence: 'high',
        inferredSection: '',
        inferredTitle: '',
        titleMatch: 'unknown',
      },
      0
    );
    expect(r['warnings']).toBeUndefined();
  });

  it('still attaches sectionInference (with note) when method is not metadata', async () => {
    const { buildParseResponse } = await import('./parse-document-handler.js');
    const tree = { id: 'r', section: '09 91 23', title: 't', parts: [] };
    const r = buildParseResponse(
      's1',
      tree,
      {
        method: 'content-high',
        confidence: 'high',
        inferredSection: '26 09 33',
        inferredTitle: 'MOTOR CONTROLLERS',
        titleMatch: 'unknown',
      },
      2
    );
    expect(r['sectionInference']).toMatchObject({ method: 'content-high' });
    expect((r['sectionInference'] as { note: string }).note).toContain('Section metadata missing');
  });
});

describe('handleParseDocument', () => {
  it('extension gate: exactly one allowlist of parse-document extensions exists — .pdf is accepted, no longer hard-rejected', async () => {
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: BASE_TREE,
      refs: [],
      sectionInference: METADATA_INFERENCE,
    });
    const { handleParseDocument } = await import('./parse-document-handler.js');

    const result = await handleParseDocument({
      filename: 'spec.pdf',
      contentBase64: b64('%PDF-1.7'),
    });

    expect(result).not.toMatchObject({ isError: true });
    expect(parser.parse).toHaveBeenCalledWith(expect.any(Buffer), 'spec.pdf', undefined);
    expect(vi.mocked(parser.assertPdfSafe)).toHaveBeenCalled();
  });

  it('extension gate: an extension outside the shared allowlist is still rejected', async () => {
    const { handleParseDocument } = await import('./parse-document-handler.js');

    const result = await handleParseDocument({ filename: 'spec.xyz', contentBase64: b64('x') });

    expect(result).toMatchObject({ isError: true });
    expect((result.content[0] as { text: string }).text).toContain('Unsupported extension: .xyz');
  });

  it('overrides: a supplied section override wins over the parsed tree section (REST override-always-wins precedence)', async () => {
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: BASE_TREE,
      refs: [],
      sectionInference: METADATA_INFERENCE,
    });
    const db = await import('../db/index.js');
    const { handleParseDocument } = await import('./parse-document-handler.js');

    await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
      section: '26 09 33',
    });

    const persisted = vi.mocked(db.persistParsedSpec).mock.calls[0]?.[0];
    expect(persisted?.tree.section).toBe('26 09 33');
  });

  it('overrides: a supplied title override wins over the parsed tree title', async () => {
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: BASE_TREE,
      refs: [],
      sectionInference: METADATA_INFERENCE,
    });
    const db = await import('../db/index.js');
    const { handleParseDocument } = await import('./parse-document-handler.js');

    await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
      title: 'Motor Controllers',
    });

    const persisted = vi.mocked(db.persistParsedSpec).mock.calls[0]?.[0];
    expect(persisted?.tree.title).toBe('Motor Controllers');
  });

  it("overrides: an invalid section override format is rejected with REST's exact message", async () => {
    const { handleParseDocument } = await import('./parse-document-handler.js');

    const result = await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
      section: 'not-a-section',
    });

    expect(result).toMatchObject({ isError: true });
    expect((result.content[0] as { text: string }).text).toBe('invalid section override format');
  });

  it('overrides: numberingProfileId resolves via getNumberingProfile and threads its rules into parse()', async () => {
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: BASE_TREE,
      refs: [],
      sectionInference: METADATA_INFERENCE,
    });
    const db = await import('../db/index.js');
    const fakeRules = { tiers: [] };
    vi.mocked(db.getNumberingProfile).mockResolvedValue({
      id: FAKE_PROFILE_ID,
      libraryId: null,
      name: 'Test Profile',
      rules: fakeRules,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const { handleParseDocument } = await import('./parse-document-handler.js');

    await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
      numberingProfileId: FAKE_PROFILE_ID,
    });

    expect(vi.mocked(db.getNumberingProfile)).toHaveBeenCalledWith(FAKE_PROFILE_ID);
    expect(parser.parse).toHaveBeenCalledWith(expect.any(Buffer), 'spec.txt', {
      numberingProfile: fakeRules,
    });
  });

  it("overrides: an unknown numberingProfileId is rejected with REST's exact message", async () => {
    const db = await import('../db/index.js');
    vi.mocked(db.getNumberingProfile).mockResolvedValue(null);
    const { handleParseDocument } = await import('./parse-document-handler.js');

    const result = await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
      numberingProfileId: FAKE_PROFILE_ID,
    });

    expect(result).toMatchObject({ isError: true });
    expect((result.content[0] as { text: string }).text).toBe('numbering profile not found');
  });

  it('inference: never substitutes an inferred "unknown" title over a real detected value', async () => {
    // Regression for the old enrichInferenceForMcp, which unconditionally wrote
    // `title: raw.inferredTitle` whenever the section was content-inferred —
    // even when title inference itself came back 'unknown' and the tree
    // already carried a real title. parser/index.ts's applyInference (which
    // now owns this) guards each field independently.
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: { id: 'r', section: '09 91 23', title: 'Real Detected Title', parts: [] },
      refs: [],
      sectionInference: {
        method: 'content-high',
        confidence: 'high',
        inferredSection: '09 91 23',
        inferredTitle: 'unknown',
        titleMatch: 'unknown',
      },
    });
    const db = await import('../db/index.js');
    const { handleParseDocument } = await import('./parse-document-handler.js');

    await handleParseDocument({ filename: 'spec.txt', contentBase64: b64('plain text') });

    const persisted = vi.mocked(db.persistParsedSpec).mock.calls[0]?.[0];
    expect(persisted?.tree.title).toBe('Real Detected Title');
  });

  it('never throws past its own catch — an unexpected persistParsedSpec rejection surfaces as isError (#567 sweep)', async () => {
    const parser = await import('../parser/index.js');
    vi.mocked(parser.parse).mockResolvedValue({
      tree: BASE_TREE,
      refs: [],
      sectionInference: METADATA_INFERENCE,
    });
    const db = await import('../db/index.js');
    vi.mocked(db.persistParsedSpec).mockRejectedValueOnce(new Error('connection reset'));
    const { handleParseDocument } = await import('./parse-document-handler.js');

    const result = await handleParseDocument({
      filename: 'spec.txt',
      contentBase64: b64('plain text'),
    });

    expect(result).toMatchObject({ isError: true });
    expect((result.content[0] as { text: string }).text).toBe('Internal error — parse failed');
  });
});
