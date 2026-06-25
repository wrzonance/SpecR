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
});
