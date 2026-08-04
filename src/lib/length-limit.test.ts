// src/lib/length-limit.test.ts
//
// #642 (ADR-091) — codePointMax is the single helper every length-bounded
// string field routes through. This file pins:
//
// 1. codePointLength — the raw counter, including the short-circuit `limit`
//    path used to avoid materializing a multi-million-element array for the
//    ~7 MB imageData field.
// 2. codePointMax — enforcement (boundary accept/reject on an ASTRAL
//    character, not a BMP one, so a UTF-16-unit-counting regression would
//    fail this) AND publication (the generated JSON Schema carries
//    `maxLength` and the `x-length-unit` marker), through .optional(),
//    .nullish(), and a later .describe(override).
// 3. A MUTATION-VERIFICATION test proving the assertion in (2) actually
//    distinguishes a correctly-built field from a broken one. The issue's
//    suggested mutation (swap .refine()/.meta() order) does NOT reproduce a
//    bug on this toolchain (zod 4.4.3 / MCP SDK 1.29.0 — verified by spike:
//    both orders publish maxLength identically). The failure mode that DOES
//    reproduce is omitting .meta() entirely, so that is what this test
//    mutates.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  codePointLength,
  codePointMax,
  LENGTH_UNIT_META_KEY,
  CODE_POINT_LENGTH_UNIT,
} from './length-limit.js';

// U+1F600 GRINNING FACE — 1 Unicode code point, 2 UTF-16 code units (a
// surrogate pair). The exact divergence ADR-091 fixes.
const ASTRAL_CHAR = '\u{1F600}';

function astralOfCodePointLength(codePoints: number): string {
  return ASTRAL_CHAR.repeat(codePoints);
}

function generatedSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' });
}

describe('codePointLength', () => {
  it('counts a BMP-only string the same as .length', () => {
    expect(codePointLength('hello')).toBe(5);
  });

  it('counts a single astral character as 1 code point, not 2 UTF-16 units', () => {
    expect(codePointLength(ASTRAL_CHAR)).toBe(1);
    expect(ASTRAL_CHAR).toHaveLength(2);
  });

  it('counts a mixed BMP + astral string correctly', () => {
    const value = `abc${ASTRAL_CHAR}de`;
    expect(codePointLength(value)).toBe(6);
    expect(value).toHaveLength(7);
  });

  it('short-circuits past `limit` without undercounting an astral char at the boundary', () => {
    // 5 BMP chars then one astral char landing exactly past a limit of 5 —
    // an implementation that short-circuits on raw index (not iterated code
    // points) risks stopping one code point short here.
    const value = `abcde${ASTRAL_CHAR}`;
    expect(codePointLength(value, 5)).toBe(6);
    expect(codePointLength(value, 10)).toBe(6);
  });

  it('handles a multi-million-character string without materializing an array (imageData scale)', () => {
    const huge = 'a'.repeat(7_000_000);
    expect(codePointLength(huge, 7_000_000)).toBe(7_000_000);
    expect(codePointLength(huge, 6_999_999)).toBe(7_000_000);
  });

  it('short-circuits the underlying iterator instead of exhausting it (regression guard: an array-based rewrite — e.g. `[...value].length` — must fully consume the iterator to build the array before it can compare against `limit`, so it would drive nextCalls into the millions here)', () => {
    let nextCalls = 0;
    // A minimal string-shaped iterable standing in for the real 7M-character
    // imageData string: same `[Symbol.iterator]()` contract, but counts how
    // many times `.next()` is pulled instead of paying for 7M real
    // characters. `codePointLength` only ever reads `value[Symbol.iterator]`,
    // so this is indistinguishable from a real string at the call site.
    const countingIterable = {
      [Symbol.iterator]: () => {
        let index = 0;
        return {
          next: (): IteratorResult<string> => {
            nextCalls += 1;
            if (index >= 7_000_000) return { done: true, value: undefined };
            index += 1;
            return { done: false, value: 'a' };
          },
        };
      },
    } as unknown as string;

    codePointLength(countingIterable, 5);

    // The real implementation stops once `count > limit` (limit=5 → 7
    // `.next()` calls). An array-materializing rewrite must exhaust the
    // iterator first, which here would mean 7,000,001 calls.
    expect(nextCalls).toBeLessThan(100);
  });
});

describe('codePointMax', () => {
  const bounded = () =>
    codePointMax(z.string().trim().min(1), 5, { description: 'a bounded field' });

  it('accepts exactly n code points of astral input (up to 2x longer in UTF-16 units than a legacy .max(n))', () => {
    const atLimit = astralOfCodePointLength(5);
    expect(atLimit).toHaveLength(10); // UTF-16 units — the old .max(5) would reject this
    expect(bounded().safeParse(atLimit).success).toBe(true);
  });

  it('rejects n + 1 code points of astral input', () => {
    const overLimit = astralOfCodePointLength(6);
    expect(bounded().safeParse(overLimit).success).toBe(false);
  });

  it('publishes maxLength and the code-point-unit marker on the generated schema', () => {
    const schema = generatedSchema(bounded());
    expect(schema['maxLength']).toBe(5);
    expect(schema[LENGTH_UNIT_META_KEY]).toBe(CODE_POINT_LENGTH_UNIT);
    expect(schema['description']).toBe('a bounded field');
  });

  it('survives .optional() — maxLength and marker still publish', () => {
    const schema = generatedSchema(bounded().optional());
    expect(schema['maxLength']).toBe(5);
    expect(schema[LENGTH_UNIT_META_KEY]).toBe(CODE_POINT_LENGTH_UNIT);
  });

  it('survives .nullish() plus a later .describe(override) — maxLength nests under anyOf but still publishes', () => {
    const schema = generatedSchema(bounded().nullish().describe('override text'));
    expect(schema['description']).toBe('override text');
    const variants = schema['anyOf'];
    expect(Array.isArray(variants)).toBe(true);
    const stringVariant = (variants as Record<string, unknown>[]).find(
      (variant) => variant['type'] === 'string'
    );
    expect(stringVariant?.['maxLength']).toBe(5);
    expect(stringVariant?.[LENGTH_UNIT_META_KEY]).toBe(CODE_POINT_LENGTH_UNIT);
  });

  it('applies a custom rejection message', () => {
    const withMessage = codePointMax(z.string(), 3, { message: 'custom message' });
    const result = withMessage.safeParse(astralOfCodePointLength(4));
    expect(result.success).toBe(false);
    expect(result.success ? undefined : result.error.issues[0]?.message).toBe('custom message');
  });
});

// ── Mutation verification (#642 sprint policy item 6) ────────────────────────
//
// The issue's suggested mutation was reordering .refine()/.meta(). Verified
// by spike (both orders in this file's helper publish identically on zod
// 4.4.3 / MCP SDK 1.29.0) that reordering is NOT the load-bearing mutation
// here. This block instead mutates the ONE thing that IS load-bearing —
// omitting .meta() — and proves the same assertion style used throughout
// this file (and both length-limit-unit-convention.test.ts gates) actually
// fails to find maxLength on the broken variant, then passes on the real
// helper. That is the mutation-kill evidence required before trusting the
// gate.
describe('mutation verification — omitting .meta() is the real failure mode, not reorder', () => {
  it('BROKEN: .refine() with no .meta() call publishes no maxLength at all', () => {
    // Deliberately NOT using codePointMax — reproduces the bug codePointMax
    // exists to prevent, to prove the assertion below would have caught it.
    const brokenField = z.string().refine((value) => codePointLength(value, 5) <= 5);
    const schema = generatedSchema(brokenField);
    expect(schema['maxLength']).toBeUndefined();
    expect(schema[LENGTH_UNIT_META_KEY]).toBeUndefined();
  });

  it('FIXED: the same bound built via codePointMax publishes maxLength and the marker', () => {
    const fixedField = codePointMax(z.string(), 5);
    const schema = generatedSchema(fixedField);
    expect(schema['maxLength']).toBe(5);
    expect(schema[LENGTH_UNIT_META_KEY]).toBe(CODE_POINT_LENGTH_UNIT);
  });

  it('both orders of .refine()/.meta() publish maxLength identically on this toolchain (documented, not assumed)', () => {
    const refineThenMeta = z
      .string()
      .refine((value) => value.length <= 5)
      .meta({ maxLength: 5 });
    const metaThenRefine = z
      .string()
      .meta({ maxLength: 5 })
      .refine((value) => value.length <= 5);
    expect(generatedSchema(refineThenMeta)['maxLength']).toBe(5);
    expect(generatedSchema(metaThenRefine)['maxLength']).toBe(5);
  });
});
