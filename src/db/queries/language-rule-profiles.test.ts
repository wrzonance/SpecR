import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  mergeLanguageRules,
  validateRules,
  LanguageRuleValidationError,
  type LanguageRuleProfile,
  type LanguageRuleScopeKind,
} from './language-rule-profiles.js';
import { MAX_LITERAL_TERM_LENGTH, MAX_LITERAL_TERMS } from '../../ast/index.js';
import type { LanguageRules } from '../../ast/index.js';

// #411 / ADR-080 — pure-function unit coverage for the query layer's two
// DB-free helpers. Everything else in this module talks to Postgres and is
// covered by language-rule-profiles.integration.test.ts instead (this
// project's unit project runs with no DB, per CLAUDE.md).

function profile(
  scope: LanguageRuleScopeKind,
  ownerId: string,
  rules: LanguageRules
): LanguageRuleProfile {
  return {
    id: `${scope}-${ownerId}`,
    scope,
    ownerId,
    rules,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('mergeLanguageRules — additive across layers (ADR-080 D5)', () => {
  it('zero layers merges to an empty rule set — opt-in default (D1)', () => {
    expect(mergeLanguageRules([])).toEqual({});
  });

  it('concatenates distinct terms across layers instead of overriding', () => {
    const broad = profile('library', 'lib-1', { bannedTerms: [{ term: 'if required' }] });
    const narrow = profile('project', 'proj-1', { bannedTerms: [{ term: 'as needed' }] });
    const merged = mergeLanguageRules([broad, narrow]);
    expect(merged.bannedTerms).toEqual([{ term: 'if required' }, { term: 'as needed' }]);
  });

  it("a narrower layer adding one term never drops the broader layer's other terms", () => {
    const broad = profile('library', 'lib-1', {
      bannedTerms: [{ term: 'if required' }, { term: 'as needed' }],
    });
    const narrow = profile('project', 'proj-1', { bannedTerms: [{ term: 'may' }] });
    const merged = mergeLanguageRules([broad, narrow]);
    expect(merged.bannedTerms).toHaveLength(3);
  });

  it('on a same-key collision the narrowest (last) layer wins the value', () => {
    const broad = profile('library', 'lib-1', {
      bannedTerms: [{ term: 'Owner', suggestion: 'library-suggestion' }],
    });
    const narrow = profile('project', 'proj-1', {
      bannedTerms: [{ term: 'owner', suggestion: 'project-suggestion' }],
    });
    const merged = mergeLanguageRules([broad, narrow]);
    expect(merged.bannedTerms).toEqual([{ term: 'owner', suggestion: 'project-suggestion' }]);
  });

  it('dedupe key includes isRegex — a literal and a regex with the same text are distinct rules', () => {
    const broad = profile('library', 'lib-1', { bannedTerms: [{ term: 'test' }] });
    const narrow = profile('project', 'proj-1', {
      bannedTerms: [{ term: 'test', isRegex: true }],
    });
    const merged = mergeLanguageRules([broad, narrow]);
    expect(merged.bannedTerms).toEqual([{ term: 'test' }, { term: 'test', isRegex: true }]);
  });

  it('merge: regex dedupe key is case-SENSITIVE — `\\s` and `\\S` are two rules, not one', () => {
    const broad = profile('library', 'lib-1', {
      bannedTerms: [{ term: '\\s+$', isRegex: true, suggestion: 'trailing whitespace' }],
    });
    const narrow = profile('project', 'proj-1', {
      bannedTerms: [{ term: '\\S+$', isRegex: true, suggestion: 'unbroken run' }],
    });
    const merged = mergeLanguageRules([broad, narrow]);
    // Lowercasing the regex source would collapse these onto one key and drop
    // the library layer's rule entirely.
    expect(merged.bannedTerms).toEqual([
      { term: '\\s+$', isRegex: true, suggestion: 'trailing whitespace' },
      { term: '\\S+$', isRegex: true, suggestion: 'unbroken run' },
    ]);
  });

  it('merge: literal terms stay case-INSENSITIVE — folding applies to literals only', () => {
    const broad = profile('library', 'lib-1', { bannedTerms: [{ term: 'Owner' }] });
    const narrow = profile('project', 'proj-1', { bannedTerms: [{ term: 'OWNER' }] });
    const merged = mergeLanguageRules([broad, narrow]);
    expect(merged.bannedTerms).toEqual([{ term: 'OWNER' }]);
  });

  it('merges each category independently — a term in one never leaks into another', () => {
    const layer = profile('library', 'lib-1', {
      bannedTerms: [{ term: 'if required' }],
      reinforcingWords: [{ term: 'any' }],
    });
    const merged = mergeLanguageRules([layer]);
    expect(merged).toEqual({
      bannedTerms: [{ term: 'if required' }],
      reinforcingWords: [{ term: 'any' }],
    });
  });

  it('omits a category key entirely when no layer contributes to it', () => {
    const layer = profile('library', 'lib-1', { bannedTerms: [{ term: 'if required' }] });
    const merged = mergeLanguageRules([layer]);
    expect(merged.reinforcingWords).toBeUndefined();
    expect(merged.partyVocabulary).toBeUndefined();
    expect(merged.requiredPhrases).toBeUndefined();
    expect(Object.keys(merged)).toEqual(['bannedTerms']);
  });
});

describe('validateRules — regex write-boundary safety (ADR-080 D6)', () => {
  it('passes through a rule set with only literal terms unchanged', () => {
    const rules: LanguageRules = {
      bannedTerms: [{ term: 'if required' }],
      partyVocabulary: [{ term: 'A/E', suggestion: "Owner's Representative" }],
    };
    expect(validateRules(rules)).toEqual(rules);
  });

  it('accepts a well-formed isRegex term', () => {
    const rules: LanguageRules = { bannedTerms: [{ term: '^\\s*any\\b', isRegex: true }] };
    expect(validateRules(rules)).toEqual(rules);
  });

  it('rejects a ReDoS-prone isRegex term with LanguageRuleValidationError', () => {
    const rules: LanguageRules = { bannedTerms: [{ term: '(a+)+$', isRegex: true }] };
    expect(() => validateRules(rules)).toThrow(LanguageRuleValidationError);
  });

  it('rejects an oversized isRegex term with LanguageRuleValidationError', () => {
    const rules: LanguageRules = {
      bannedTerms: [{ term: 'a'.repeat(500), isRegex: true }],
    };
    expect(() => validateRules(rules)).toThrow(LanguageRuleValidationError);
  });

  it('checks isRegex terms across all four categories, not just bannedTerms', () => {
    const rules: LanguageRules = {
      requiredPhrases: [{ term: '(x*)*', isRegex: true }],
    };
    expect(() => validateRules(rules)).toThrow(LanguageRuleValidationError);
  });

  it('validate: a shape failure is a LanguageRuleValidationError chaining the ZodError, not a raw ZodError', () => {
    // An empty term satisfies the TS type but violates the schema's
    // minLength(1). Before the fix `parse` let that escape the db module as an
    // unwrapped ZodError — only the REST handler pre-validates its body; MCP
    // and direct db callers do not.
    const rules: LanguageRules = { bannedTerms: [{ term: '' }] };
    let thrown: unknown;
    try {
      validateRules(rules);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LanguageRuleValidationError);
    expect(thrown instanceof LanguageRuleValidationError && thrown.cause).toBeInstanceOf(ZodError);
  });

  // ADR-080 "Negative" consequences — a conscious v1 trade-off, not a gap:
  // literal terms are always escaped before use (never compiled as regex), so
  // they are never regex-checked regardless of what they look like.
  it('never regex-checks a literal (non-isRegex) term, however unsafe it would be as a pattern', () => {
    const rules: LanguageRules = { bannedTerms: [{ term: '(a+)+$' }] };
    expect(validateRules(rules)).toEqual(rules);
  });
});

// #541 — validateRules now enforces LanguageRulesWriteSchema (the literal-term
// bound from language-rule-schemas.ts), not just LanguageRulesSchema's shape +
// checkRegexPatterns' regex-term bound. This block pins the boundary contract:
// LanguageRuleValidationError (never a raw ZodError) on any write-boundary
// violation, the regex/literal bounds staying independent, and the read path
// (LanguageRulesSchema, used by mapRow) staying unbounded/grandfathered.
describe('validateRules — literal-term write bound (#541)', () => {
  it('rejects a literal term whose text exceeds MAX_LITERAL_TERM_LENGTH with a LanguageRuleValidationError chaining the ZodError', () => {
    const rules: LanguageRules = {
      bannedTerms: [{ term: 'a'.repeat(MAX_LITERAL_TERM_LENGTH + 1) }],
    };
    let thrown: unknown;
    try {
      validateRules(rules);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LanguageRuleValidationError);
    expect(thrown instanceof LanguageRuleValidationError && thrown.cause).toBeInstanceOf(ZodError);
  });

  it('rejects a whole-profile literal-term count over MAX_LITERAL_TERMS, flattened across all 4 categories', () => {
    const perCategory = Math.ceil((MAX_LITERAL_TERMS + 1) / 4);
    const terms = Array.from({ length: perCategory }, (_, i) => ({ term: `term-${i}` }));
    const rules: LanguageRules = {
      bannedTerms: terms,
      reinforcingWords: terms,
      partyVocabulary: terms,
      requiredPhrases: terms,
    };
    expect(() => validateRules(rules)).toThrow(LanguageRuleValidationError);
  });

  it('accepts exactly MAX_LITERAL_TERM_LENGTH characters and exactly MAX_LITERAL_TERMS terms', () => {
    const rules: LanguageRules = {
      bannedTerms: Array.from({ length: MAX_LITERAL_TERMS }, (_, i) => ({
        term: i === 0 ? 'a'.repeat(MAX_LITERAL_TERM_LENGTH) : `term-${i}`,
      })),
    };
    expect(validateRules(rules)).toEqual(rules);
  });

  it('the literal-term bound and the regex-term bound are independent and unsummed — 64 regex terms AND MAX_LITERAL_TERMS literal terms together are valid', () => {
    const literalTerms = Array.from({ length: MAX_LITERAL_TERMS }, (_, i) => ({
      term: `literal-${i}`,
    }));
    const regexTerms = Array.from({ length: 64 }, (_, i) => ({
      term: `regex-${i}`,
      isRegex: true,
    }));
    const rules: LanguageRules = {
      bannedTerms: [...literalTerms, ...regexTerms],
    };
    expect(validateRules(rules)).toEqual(rules);
  });

  it('an over-count literal profile still throws even with zero regex terms present — the bounds do not offset each other', () => {
    const terms = Array.from({ length: MAX_LITERAL_TERMS + 1 }, (_, i) => ({ term: `t-${i}` }));
    const rules: LanguageRules = { bannedTerms: terms };
    expect(() => validateRules(rules)).toThrow(LanguageRuleValidationError);
  });

  it('the read path (LanguageRulesSchema, used by mapRow) stays unbounded — pre-existing rows over the literal-term bound keep parsing successfully', async () => {
    const { LanguageRulesSchema } = await import('../../ast/index.js');
    const oversized: LanguageRules = {
      bannedTerms: [{ term: 'a'.repeat(MAX_LITERAL_TERM_LENGTH + 1) }],
    };
    // The write boundary rejects this…
    expect(() => validateRules(oversized)).toThrow(LanguageRuleValidationError);
    // …but the base schema mapRow parses on read grandfathers it through.
    expect(LanguageRulesSchema.parse(oversized)).toEqual(oversized);
  });
});
