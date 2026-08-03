// src/api/language-rules-literal-bounds-openapi.test.ts
//
// #541 — the language-rule literal-term write bounds are enforced by
// LanguageRulesWriteSchema (src/ast/language-rule-schemas.ts) but must ALSO be
// mirrored in openapi.yaml, the hand-authored authoritative contract
// (ADR-026). Both `MAX_LITERAL_TERM_LENGTH` and `MAX_LITERAL_TERMS` are
// hardcoded literals duplicating derived constants, so nothing else would
// catch the contract going stale if either bound is ever changed. This pins
// the sync the same way header-footer-image-cap-openapi.test.ts pins the
// per-image maxLength: change either constant without updating openapi.yaml
// and this fails first.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MAX_LITERAL_TERM_LENGTH, MAX_LITERAL_TERMS } from '../ast/language-rule-schemas.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

const LanguageRulesArrayFieldSchema = z.object({
  type: z.literal('array'),
  maxItems: z.number(),
});

const RawSpecSchema = z.object({
  components: z.object({
    schemas: z.object({
      LanguageRuleTerm: z.object({
        properties: z.object({
          term: z.object({ type: z.literal('string'), maxLength: z.number() }),
        }),
      }),
      LanguageRules: z.object({
        properties: z.object({
          bannedTerms: LanguageRulesArrayFieldSchema,
          reinforcingWords: LanguageRulesArrayFieldSchema,
          partyVocabulary: LanguageRulesArrayFieldSchema,
          requiredPhrases: LanguageRulesArrayFieldSchema,
        }),
      }),
    }),
  }),
});

describe('openapi.yaml — language-rule literal-term bounds mirror the Zod write schema (#541)', () => {
  it('LanguageRuleTerm.term.maxLength equals MAX_LITERAL_TERM_LENGTH (drift guard)', async () => {
    const raw = RawSpecSchema.parse(await loadRawSpec());
    expect(
      raw.components.schemas.LanguageRuleTerm.properties.term.maxLength,
      'openapi.yaml LanguageRuleTerm.term.maxLength drifted from MAX_LITERAL_TERM_LENGTH — update openapi.yaml when the constant changes'
    ).toBe(MAX_LITERAL_TERM_LENGTH);
  });

  it.each(['bannedTerms', 'reinforcingWords', 'partyVocabulary', 'requiredPhrases'] as const)(
    'LanguageRules.%s.maxItems equals MAX_LITERAL_TERMS (drift guard)',
    async (field) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      expect(
        raw.components.schemas.LanguageRules.properties[field].maxItems,
        `openapi.yaml LanguageRules.${field}.maxItems drifted from MAX_LITERAL_TERMS — update openapi.yaml when the constant changes`
      ).toBe(MAX_LITERAL_TERMS);
    }
  );
});
