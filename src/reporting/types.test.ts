import { describe, it, expect } from 'vitest';
import { CompareRequestSchema } from './types.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('CompareRequestSchema', () => {
  it('compare: duplicate source ids rejected — a spec cannot be compared with itself', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, A] }).success).toBe(false);
  });

  it('accepts two distinct source ids', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B] }).success).toBe(true);
  });

  it('compare: baseline not among sources is rejected', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B], baseline: C }).success).toBe(false);
  });

  it('accepts a baseline that is one of the sources', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B], baseline: A }).success).toBe(true);
  });
});

describe('CompareRequestSchema — alignment & include', () => {
  it('defaults alignment to "auto" and include to "all"', () => {
    const parsed = CompareRequestSchema.parse({ sources: [A, B] });
    expect(parsed.alignment).toBe('auto');
    expect(parsed.include).toBe('all');
  });

  it('accepts explicit alignment and include', () => {
    const parsed = CompareRequestSchema.parse({
      sources: [A, B],
      alignment: 'structure',
      include: 'differences',
    });
    expect(parsed.alignment).toBe('structure');
    expect(parsed.include).toBe('differences');
  });

  it('rejects an unknown alignment mode', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B], alignment: 'fuzzy' }).success).toBe(
      false
    );
  });
});
