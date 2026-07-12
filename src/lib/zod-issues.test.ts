import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatZodIssues } from './zod-issues.js';

describe('formatZodIssues', () => {
  it('joins a single issue message verbatim', () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 42 });
    if (result.success) throw new Error('expected parse failure');
    expect(formatZodIssues(result.error)).toBe(result.error.issues[0]?.message);
  });

  it('joins multiple issue messages with "; "', () => {
    const result = z
      .object({ name: z.string(), age: z.number() })
      .safeParse({ name: 42, age: 'old' });
    if (result.success) throw new Error('expected parse failure');
    expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    expect(formatZodIssues(result.error)).toBe(
      result.error.issues.map((i) => i.message).join('; ')
    );
  });

  it('returns an empty string for a ZodError with no issues', () => {
    const empty = new z.ZodError([]);
    expect(formatZodIssues(empty)).toBe('');
  });
});
