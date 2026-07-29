import { describe, it, expect } from 'vitest';
import { CompareRequestSchema } from './types.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const REV1 = '44444444-4444-4444-8444-444444444444';
const REV2 = '55555555-5555-4555-8555-555555555555';

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

describe('CompareRequestSchema — sources always resolves to exactly 2 elements (#392)', () => {
  it('rejects fewer than 2 sources', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A] }).success).toBe(false);
  });

  it('rejects more than 2 sources', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, B, C] }).success).toBe(false);
  });

  it('accepts exactly 2 sources mixing a live (bare-uuid) source with a frozen source object', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [A, { revisionId: REV1, specId: B }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts exactly 2 frozen source objects', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [
        { revisionId: REV1, specId: A },
        { revisionId: REV2, specId: A },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a frozen source object missing specId', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, { revisionId: REV1 }] }).success).toBe(
      false
    );
  });

  it('rejects a frozen source object with an extra, unrecognized property', () => {
    expect(
      CompareRequestSchema.safeParse({
        sources: [A, { revisionId: REV1, specId: B, extra: 'nope' }],
      }).success
    ).toBe(false);
  });

  it('rejects a source that is neither a bare uuid nor a frozen-source object', () => {
    expect(CompareRequestSchema.safeParse({ sources: [A, 'not-a-uuid'] }).success).toBe(false);
    expect(CompareRequestSchema.safeParse({ sources: [A, 42] }).success).toBe(false);
  });
});

describe('CompareRequestSchema — distinctness uses canonical source identity, not raw-value Set (#392)', () => {
  it('rejects two structurally-identical frozen source objects (same revisionId + specId)', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [
        { revisionId: REV1, specId: A },
        { revisionId: REV1, specId: A },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a live source paired with a frozen source of the SAME underlying spec', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [A, { revisionId: REV1, specId: A }],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the same spec frozen at two different revisions', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [
        { revisionId: REV1, specId: A },
        { revisionId: REV2, specId: A },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('CompareRequestSchema — baseline must match exactly one source (#392)', () => {
  it('rejects a baseline matching zero sources (unrelated id)', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [{ revisionId: REV1, specId: A }, B],
      baseline: C,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a baseline matching two sources (same spec frozen twice)', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [
        { revisionId: REV1, specId: A },
        { revisionId: REV2, specId: A },
      ],
      baseline: A,
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a baseline resolved against a frozen source’s specId (not literal array membership)', () => {
    const parsed = CompareRequestSchema.safeParse({
      sources: [{ revisionId: REV1, specId: A }, B],
      baseline: A,
    });
    expect(parsed.success).toBe(true);
  });
});
