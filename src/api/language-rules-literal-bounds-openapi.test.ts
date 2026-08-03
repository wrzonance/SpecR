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
//
// Review finding (#541 follow-up): each of bannedTerms/reinforcingWords/
// partyVocabulary/requiredPhrases declares `maxItems: 500` INDEPENDENTLY, but
// the real write-boundary bound (LanguageRulesWriteSchema/MAX_LITERAL_TERMS)
// is a combined cap of 500 literal terms flattened across all 4 categories
// together. A client that reads only one field's own schema/description (the
// common case for generated-client docs, which render properties in
// isolation) would reasonably conclude each array independently allows 500 —
// a belief the LanguageRules object-level description alone does not correct
// if the reader never scrolls up to it. The two tests below close that gap:
// (1) pins that each field's OWN description states the combined bound in
// terms readable without the parent object's prose, and (2) is paired with an
// end-to-end integration test (language-rule-profiles.integration.test.ts)
// proving a payload that is valid against every field's own maxItems can
// still be rejected 422 for exceeding the combined total.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MAX_LITERAL_TERM_LENGTH, MAX_LITERAL_TERMS } from '../ast/language-rule-schemas.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

const LanguageRulesArrayFieldSchema = z.object({
  type: z.literal('array'),
  maxItems: z.number(),
  description: z.string(),
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

  it.each(['bannedTerms', 'reinforcingWords', 'partyVocabulary', 'requiredPhrases'] as const)(
    "LanguageRules.%s's OWN description states the combined (not per-field) literal-term cap",
    async (field) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const description = raw.components.schemas.LanguageRules.properties[field].description;
      expect(
        description,
        `openapi.yaml LanguageRules.${field}.description must warn readers this field's ` +
          `maxItems is NOT independent — it shares one combined ${MAX_LITERAL_TERMS}-term cap ` +
          'with the other 3 literal-term categories (a reader viewing only this field would ' +
          'otherwise assume its maxItems applies on its own)'
      ).toMatch(/combined/i);
      expect(
        description,
        `openapi.yaml LanguageRules.${field}.description must name the number`
      ).toContain(String(MAX_LITERAL_TERMS));
    }
  );
});
