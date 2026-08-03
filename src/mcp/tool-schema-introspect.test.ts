import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { toolInputKeys, isFullSchemaInstance } from './tool-schema-introspect.js';

// ─── #549 task 3: toolInputKeys / isFullSchemaInstance ──
//
// These two functions are the SDK-introspection boundary the contract-parity
// invariants (task 4/5) build on: toolInputKeys tells INV-4 which flat keys a
// tool actually accepts once the SDK has normalized its inputSchema exactly as
// registration would; isFullSchemaInstance tells INV-5 whether an object-level
// `.strict()`/`.check()` rule on the schema a tool was BUILT from survives that
// same normalization, or gets silently discarded because the tool was handed a
// `.shape` spread instead of the schema itself. Per the design (spike finding
// 1), isFullSchemaInstance is pinned against the 4 real patterns found in
// tools.ts et al. via reference-identity against the SDK's own
// normalizeObjectSchema — never a hand-rolled duck-type probe.

const RawSourceSchema = z.object({ id: z.uuid(), name: z.string() }).strict();
const ExtendedSchema = RawSourceSchema.extend({ extra: z.string().optional() });

describe('toolInputKeys', () => {
  it('is empty for an undeclared inputSchema (undefined)', () => {
    expect(toolInputKeys(undefined)).toEqual(new Set());
  });

  it('reads keys off a raw { key: ZodType } shape literal (a .shape spread)', () => {
    expect(toolInputKeys({ ...RawSourceSchema.shape })).toEqual(new Set(['id', 'name']));
  });

  it('reads keys off a bare schema instance passed through unchanged', () => {
    expect(toolInputKeys(RawSourceSchema)).toEqual(new Set(['id', 'name']));
  });

  it('reads keys off an .extend() result, including the added key', () => {
    expect(toolInputKeys(ExtendedSchema)).toEqual(new Set(['id', 'name', 'extra']));
  });
});

describe('isFullSchemaInstance', () => {
  it('is false for undefined (no declared inputSchema)', () => {
    expect(isFullSchemaInstance(undefined)).toBe(false);
  });

  it('is false for a raw shape literal (.shape spread) — the SDK rebuilds it, losing .strict()', () => {
    expect(isFullSchemaInstance({ ...RawSourceSchema.shape })).toBe(false);
  });

  it('is true for a bare schema instance passed through unchanged — .strict() survives', () => {
    expect(isFullSchemaInstance(RawSourceSchema)).toBe(true);
  });

  it('is true for an .extend() result — still a full schema instance', () => {
    expect(isFullSchemaInstance(ExtendedSchema)).toBe(true);
  });
});

describe('boundary invariant: no private zod-v4 internals, no unsafe cast', () => {
  // Structural pin (mirrors the src/mcp/handlers-tools-line-budget.test.ts
  // precedent of asserting a source-level property directly): the whole point
  // of routing through the SDK's own normalizeObjectSchema/getObjectShape is
  // to never touch zod v4's private `_zod.def.*` shape, and never paper over
  // a mismatch with `as unknown as` or a bare `as`. If a future edit reaches
  // for either, this test names exactly what broke instead of surfacing as a
  // silent behavioral drift from the SDK's own normalization.
  //
  // These are pattern-based, not literal-substring, checks: a plain
  // `.not.toContain('_zod.')` / `.not.toContain('as any')` only catches the
  // exact spelling on the day it was written — bracket-notation access
  // (`x['_zod']`), an angle-bracket type assertion (`<any>x`), or extra
  // whitespace inside `as unknown as` all bypass a literal substring match
  // while doing the exact same unsafe thing. The regexes below are verified
  // against those bypass shapes in the second describe block, so the check
  // is pinned to the behavior it exists to catch, not to today's formatting.
  const source = readFileSync(
    fileURLToPath(new URL('./tool-schema-introspect.ts', import.meta.url)),
    'utf8'
  );

  // Dot access (`_zod.def`) or bracket access (`['_zod']` / `["_zod"]`),
  // tolerant of whitespace around the brackets/quotes.
  const PRIVATE_ZOD_INTERNAL = /\.\s*_zod\b|\[\s*(['"])_zod\1\s*\]/;

  // `as any`, `as unknown as <Type>` (any amount of whitespace, including
  // newlines, between the tokens), or an angle-bracket assertion
  // (`<any>x` / `<unknown>x`). The negative lookbehind on the angle-bracket
  // form excludes generic instantiations like `Promise<any>`, which are
  // preceded by an identifier character rather than an expression boundary.
  const UNSAFE_CAST = /\bas\s+any\b|\bas\s+unknown\s+as\b|(?<![\w$])<\s*(?:any|unknown)\s*>/;

  it('never reads zod v4 private internals (_zod.), including bracket-notation access', () => {
    expect(PRIVATE_ZOD_INTERNAL.test(source)).toBe(false);
  });

  it('never performs an unsafe cast (as unknown as / as any / angle-bracket assertion)', () => {
    expect(UNSAFE_CAST.test(source)).toBe(false);
  });

  describe('the checks above actually catch respelled bypasses (not just the literal substrings)', () => {
    it('PRIVATE_ZOD_INTERNAL catches single-quoted bracket access', () => {
      expect(PRIVATE_ZOD_INTERNAL.test("const shape = schema['_zod'].def.shape;")).toBe(true);
    });

    it('PRIVATE_ZOD_INTERNAL catches double-quoted bracket access with extra whitespace', () => {
      expect(PRIVATE_ZOD_INTERNAL.test('const shape = schema[ "_zod" ].def.shape;')).toBe(true);
    });

    it('UNSAFE_CAST catches an angle-bracket cast to any', () => {
      expect(UNSAFE_CAST.test('const shape = (<any>schema).def;')).toBe(true);
    });

    it('UNSAFE_CAST catches an angle-bracket cast to unknown', () => {
      expect(UNSAFE_CAST.test('const shape = (<unknown>schema) as Shape;')).toBe(true);
    });

    it('UNSAFE_CAST catches "as unknown as" split across a newline', () => {
      expect(UNSAFE_CAST.test('const shape = schema as unknown\n  as Shape;')).toBe(true);
    });

    it('UNSAFE_CAST does not false-positive on a generic instantiation', () => {
      expect(UNSAFE_CAST.test('const p: Promise<any> = fetchSchema();')).toBe(false);
    });
  });
});
