import { describe, it, expect } from 'vitest';
import {
  LanguageRuleTermSchema,
  LanguageRulesSchema,
  PutLanguageRulesBodySchema,
} from './language-rule-schemas.js';

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
