import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./env.js', () => ({
  config: { OCR_MIN_CHARS_PER_PAGE: 24 },
}));

vi.mock('../parser/index.js', () => ({
  parse: vi.fn().mockResolvedValue({
    tree: {
      id: '00000000-0000-0000-0000-000000000005',
      section: '27 10 00',
      title: 'Structured Cabling',
      parts: [],
    },
    refs: [],
    capabilities: ['read-only'],
  }),
}));

// Both upload handlers (parse, onboarding) parse the worker's structured-clone
// return with this single schema before use — it is the boundary that turns an
// untrusted cross-thread payload into a clean ZodError instead of an uncaught
// cast (CodeRabbit finding: validate worker output at the boundary).

describe('workerOutputSchema', () => {
  it('accepts a well-formed worker output', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: '09 91 26', title: 'Painting', parts: [] },
      refs: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts 'unknown' as the section sentinel and defaults refs", async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: 'unknown', title: 'T', parts: [] },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.refs).toEqual([]);
  });

  it('rejects a malformed worker output (missing tree) with a ZodError', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const result = workerOutputSchema.safeParse({ refs: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
  });

  it('rejects a non-object payload', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    expect(workerOutputSchema.safeParse('not an object').success).toBe(false);
    expect(workerOutputSchema.safeParse(null).success).toBe(false);
  });

  it('rejects an invalid section number that is not the unknown sentinel', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: 'not-a-section', title: 'T', parts: [] },
      refs: [],
    });
    expect(result.success).toBe(false);
  });

  // #293 regression: the worker's structured-clone boundary must round-trip
  // tree.hiddenTables, not silently strip it. Zod objects drop unknown keys by
  // default, so if workerOutputSchema's tree sub-schema doesn't declare
  // hiddenTables, every hidden DOCX table retained by extractTables() vanishes
  // here — the only path real uploads (parse, onboarding) actually exercise.
  it('preserves tree.hiddenTables across the worker boundary instead of stripping it', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const result = workerOutputSchema.safeParse({
      tree: {
        id: 's1',
        section: '09 91 26',
        title: 'Painting',
        parts: [],
        hiddenTables: [{ rows: [['secret A', 'secret B']] }],
      },
      refs: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tree.hiddenTables).toEqual([{ rows: [['secret A', 'secret B']] }]);
    }
  });

  // #306 regression (mirrors #293): the worker's structured-clone boundary
  // must round-trip tree.headerFooter, not silently strip it. Zod objects
  // drop unknown keys by default, so if workerOutputSchema's tree sub-schema
  // doesn't declare headerFooter, every captured DOCX header/footer
  // composition from captureHeaderFooter() vanishes here — the only path
  // real uploads (parse, onboarding) actually exercise.
  it('preserves tree.headerFooter across the worker boundary instead of stripping it', async () => {
    const { workerOutputSchema } = await import('./parse-worker.js');
    const headerFooter = {
      variants: {
        default: {
          header: { center: { content: [{ kind: 'sectionTitle' as const }] } },
        },
      },
      raw: {
        warnings: ['footer image on default variant was not captured (kind=image)'],
        unmodeled: [
          {
            variant: 'default' as const,
            region: 'footer' as const,
            kind: 'image' as const,
            detail: { rId: 'rId7' },
          },
        ],
      },
    };
    const result = workerOutputSchema.safeParse({
      tree: {
        id: 's1',
        section: '09 91 26',
        title: 'Painting',
        parts: [],
        headerFooter,
      },
      refs: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tree.headerFooter).toEqual(headerFooter);
    }
  });
});

describe('parseWorker', () => {
  it('passes the configured OCR threshold to the parser composition root', async () => {
    const parseWorker = (await import('./parse-worker.js')).default;
    const { parse } = await import('../parser/index.js');
    const buffer = Buffer.from('%PDF-1.4');

    const result = await parseWorker({ buffer, ext: '.pdf' });

    expect(parse).toHaveBeenCalledWith(buffer, 'upload.pdf', { ocrMinCharsPerPage: 24 });
    expect(result.capabilities).toEqual(['read-only']);
  });

  it('threads an assigned numbering profile into the parse options (#299)', async () => {
    const parseWorker = (await import('./parse-worker.js')).default;
    const { parse } = await import('../parser/index.js');
    vi.mocked(parse).mockClear();
    const buffer = Buffer.from('PK\x03\x04');
    const numberingProfile = {
      tiers: { part: { numberStyle: 'integer' as const, maxCount: 5 } },
      numbering: [{ numId: 7, levels: [{ ilvl: 0, tier: 'part' as const }] }],
      styleLadder: [],
      articleIlvl: 2,
    };

    await parseWorker({ buffer, ext: '.docx', numberingProfile });

    expect(parse).toHaveBeenCalledWith(buffer, 'upload.docx', {
      ocrMinCharsPerPage: 24,
      numberingProfile,
    });
  });

  it('omits numberingProfile from parse options when none is assigned (byte-for-byte)', async () => {
    const parseWorker = (await import('./parse-worker.js')).default;
    const { parse } = await import('../parser/index.js');
    vi.mocked(parse).mockClear();
    const buffer = Buffer.from('PK\x03\x04');

    await parseWorker({ buffer, ext: '.docx' });

    // No numberingProfile key at all — identical to the pre-#299 call shape.
    expect(parse).toHaveBeenCalledWith(buffer, 'upload.docx', { ocrMinCharsPerPage: 24 });
  });
});
