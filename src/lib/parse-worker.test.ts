import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { workerOutputSchema } from './parse-worker.js';

// Both upload handlers (parse, onboarding) parse the worker's structured-clone
// return with this single schema before use — it is the boundary that turns an
// untrusted cross-thread payload into a clean ZodError instead of an uncaught
// cast (CodeRabbit finding: validate worker output at the boundary).

describe('workerOutputSchema', () => {
  it('accepts a well-formed worker output', () => {
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: '09 91 26', title: 'Painting', parts: [] },
      refs: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts 'unknown' as the section sentinel and defaults refs", () => {
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: 'unknown', title: 'T', parts: [] },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.refs).toEqual([]);
  });

  it('rejects a malformed worker output (missing tree) with a ZodError', () => {
    const result = workerOutputSchema.safeParse({ refs: [] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBeInstanceOf(z.ZodError);
  });

  it('rejects a non-object payload', () => {
    expect(workerOutputSchema.safeParse('not an object').success).toBe(false);
    expect(workerOutputSchema.safeParse(null).success).toBe(false);
  });

  it('rejects an invalid section number that is not the unknown sentinel', () => {
    const result = workerOutputSchema.safeParse({
      tree: { id: 's1', section: 'not-a-section', title: 'T', parts: [] },
      refs: [],
    });
    expect(result.success).toBe(false);
  });
});
