import { describe, it, expect } from 'vitest';
import {
  LanguageRuleTermSchema,
  LanguageRulesSchema,
  PutLanguageRulesBodySchema,
  LanguageRulesWriteSchema,
  MAX_LITERAL_TERM_LENGTH,
  MAX_LITERAL_TERMS,
} from './language-rule-schemas.js';
import type { LanguageRuleTerm } from './language-rule-schemas.js';

// #411 / ADR-080 — schema layer only (task 3/8 of this feature). The matching
// engine (task 4) and the query/resolution layer (also task 4+) land later;
// this file pins the wire-shape contract those tasks are built against.

describe('LanguageRuleTermSchema', () => {
  it('accepts a minimal literal term (term only)', () => {
    expect(LanguageRuleTermSchema.parse({ term: 'shall' })).toEqual({ term: 'shall' });
  });

  it('accepts isRegex and suggestion alongside term', () => {
    const input = {
      term: '^\\s*any\\b',
      isRegex: true,
      suggestion: 'name the item, or use "all"',
    };
    expect(LanguageRuleTermSchema.parse(input)).toEqual(input);
  });

  it('rejects an empty term', () => {
    expect(LanguageRuleTermSchema.safeParse({ term: '' }).success).toBe(false);
  });

  it('rejects unknown keys (.strict())', () => {
    const result = LanguageRuleTermSchema.safeParse({ term: 'shall', extra: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('LanguageRulesSchema', () => {
  it('accepts an empty object — every category starts empty (ADR-080 D1)', () => {
    expect(LanguageRulesSchema.parse({})).toEqual({});
  });

  it('accepts all four categories populated', () => {
    const input = {
      bannedTerms: [{ term: 'if required' }],
      reinforcingWords: [{ term: 'any' }, { term: 'all' }],
      partyVocabulary: [{ term: 'A/E', suggestion: "Owner's Representative" }],
      requiredPhrases: [{ term: 'furnish and install' }],
    };
    expect(LanguageRulesSchema.parse(input)).toEqual(input);
  });

  it('rejects unknown top-level keys (.strict())', () => {
    expect(LanguageRulesSchema.safeParse({ bannedWords: [] }).success).toBe(false);
  });

  it('rejects a category entry that fails LanguageRuleTermSchema', () => {
    expect(LanguageRulesSchema.safeParse({ bannedTerms: [{ term: '' }] }).success).toBe(false);
  });

  // Mirrors schemas.test.ts' INV-5 pattern: exactOptionalPropertyTypes
  // distinguishes "key absent" from "key present with value undefined". A
  // regression that swaps .exactOptional() for .optional() would still pass
  // every other test in this block (they never pass the key at all) but would
  // silently accept a present-but-undefined key here.
  it('rejects an explicit bannedTerms: undefined (exactOptional, not optional)', () => {
    expect(LanguageRulesSchema.safeParse({ bannedTerms: undefined }).success).toBe(false);
  });

  // D2 (spike correction, ADR-080) — every category array must be frozen at
  // parse time so `z.infer` produces `readonly T[]`, matching this codebase's
  // "never mutate inputs" rule. Without `.readonly()` here, the merge/scan
  // layer's pure helpers (which return `readonly T[]`) fail `tsc --noEmit`
  // (TS4104) when their result is assigned back into a LanguageRules-typed
  // value — reproduced by the pre-implementation spike. This is a deliberate,
  // new-to-this-schema pattern: do not "clean it up" to match
  // ConventionRulesSchema, which has no `.readonly()` and doesn't need one.
  it('freezes every category array at parse time (D2 — readonly)', () => {
    const parsed = LanguageRulesSchema.parse({
      bannedTerms: [{ term: 'a' }],
      reinforcingWords: [{ term: 'b' }],
      partyVocabulary: [{ term: 'c' }],
      requiredPhrases: [{ term: 'd' }],
    });
    expect(Object.isFrozen(parsed.bannedTerms)).toBe(true);
    expect(Object.isFrozen(parsed.reinforcingWords)).toBe(true);
    expect(Object.isFrozen(parsed.partyVocabulary)).toBe(true);
    expect(Object.isFrozen(parsed.requiredPhrases)).toBe(true);
  });
});

describe('PutLanguageRulesBodySchema', () => {
  it('accepts { rules } wrapping a LanguageRules payload', () => {
    const input = { rules: { bannedTerms: [{ term: 'if required' }] } };
    expect(PutLanguageRulesBodySchema.parse(input)).toEqual(input);
  });

  it('rejects a body missing rules', () => {
    expect(PutLanguageRulesBodySchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown top-level keys (.strict())', () => {
    expect(PutLanguageRulesBodySchema.safeParse({ rules: {}, name: 'x' }).success).toBe(false);
  });
});

// #541 — write-boundary literal-term bounds, mirroring the
// HeaderFooterCompositionWriteSchema precedent (ADR-070): a write-only
// sibling `.check()` layered on the otherwise-identical structural schema.
describe('LanguageRulesWriteSchema — literal-term bounds (#541)', () => {
  function bannedTerm(term: string, extra: Partial<LanguageRuleTerm> = {}): LanguageRuleTerm {
    return { term, ...extra };
  }

  it('accepts a profile within both the per-term length and whole-profile count bounds', () => {
    const input = {
      bannedTerms: [bannedTerm('shall'), bannedTerm('a'.repeat(MAX_LITERAL_TERM_LENGTH))],
    };
    expect(LanguageRulesWriteSchema.parse(input)).toEqual(input);
  });

  it('rejects a literal term whose text exceeds MAX_LITERAL_TERM_LENGTH', () => {
    const input = { bannedTerms: [bannedTerm('a'.repeat(MAX_LITERAL_TERM_LENGTH + 1))] };
    expect(LanguageRulesWriteSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a regex term whose source exceeds MAX_LITERAL_TERM_LENGTH — the literal bound never applies to isRegex:true terms', () => {
    const input = {
      bannedTerms: [bannedTerm('a'.repeat(MAX_LITERAL_TERM_LENGTH + 1), { isRegex: true })],
    };
    expect(LanguageRulesWriteSchema.parse(input)).toEqual(input);
  });

  it('rejects a whole-profile literal-term count over MAX_LITERAL_TERMS, flattened across all 4 categories', () => {
    const perCategory = Math.ceil((MAX_LITERAL_TERMS + 1) / 4);
    const terms = Array.from({ length: perCategory }, (_, i) => bannedTerm(`term-${i}`));
    const input = {
      bannedTerms: terms,
      reinforcingWords: terms,
      partyVocabulary: terms,
      requiredPhrases: terms,
    };
    expect(LanguageRulesWriteSchema.safeParse(input).success).toBe(false);
  });

  it('accepts exactly MAX_LITERAL_TERMS literal terms', () => {
    const terms = Array.from({ length: MAX_LITERAL_TERMS }, (_, i) => bannedTerm(`term-${i}`));
    expect(LanguageRulesWriteSchema.parse({ bannedTerms: terms })).toEqual({ bannedTerms: terms });
  });

  it('allows 64 regex terms AND MAX_LITERAL_TERMS literal terms together — the two bounds are independent and unsummed', () => {
    const literalTerms = Array.from({ length: MAX_LITERAL_TERMS }, (_, i) =>
      bannedTerm(`lit-${i}`)
    );
    const regexTerms = Array.from({ length: 64 }, (_, i) =>
      bannedTerm(`^rx-${i}$`, { isRegex: true })
    );
    const input = { bannedTerms: [...literalTerms, ...regexTerms] };
    expect(LanguageRulesWriteSchema.parse(input)).toEqual(input);
  });

  it('the base LanguageRulesSchema (read path) stays unbounded — a pre-existing over-length term keeps parsing (grandfathering)', () => {
    const oversized = { bannedTerms: [bannedTerm('a'.repeat(MAX_LITERAL_TERM_LENGTH + 1))] };
    expect(LanguageRulesSchema.parse(oversized)).toEqual(oversized);
  });

  it('the base LanguageRulesSchema (read path) stays unbounded — a pre-existing over-count profile keeps parsing (grandfathering)', () => {
    const terms = Array.from({ length: MAX_LITERAL_TERMS + 1 }, (_, i) => bannedTerm(`term-${i}`));
    const input = { bannedTerms: terms };
    expect(LanguageRulesSchema.parse(input)).toEqual(input);
  });
});
