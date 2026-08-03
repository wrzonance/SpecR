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
// Review finding (#541 follow-up, write/read schema split): the bound MUST
// live only on the write-only LanguageRuleTermWrite/LanguageRulesWrite
// schemas (referenced solely by PutLanguageRulesBody), never on the shared
// LanguageRuleTerm/LanguageRules schemas that LanguageRuleProfile.rules also
// uses for GET responses. mapRow's read path (LanguageRulesSchema) is
// required to keep grandfathering pre-existing rows that already exceed
// these bounds; if the shared schema carried the bound structurally, a
// grandfathered row would fail its own GET response's declared contract.
// See src/api/contract.integration.test.ts's "GET reflects a grandfathered
// profile..." test for the end-to-end proof.
//
// Review finding (#541 follow-up): each of bannedTerms/reinforcingWords/
// partyVocabulary/requiredPhrases declares `maxItems: 500` INDEPENDENTLY, but
// the real write-boundary bound (LanguageRulesWriteSchema/MAX_LITERAL_TERMS)
// is a combined cap of 500 literal terms flattened across all 4 categories
// together. A client that reads only one field's own schema/description (the
// common case for generated-client docs, which render properties in
// isolation) would reasonably conclude each array independently allows 500 —
// a belief the LanguageRulesWrite object-level description alone does not
// correct if the reader never scrolls up to it. The tests below close that
// gap: (1) pins that each field's OWN description states the combined bound
// in terms readable without the parent object's prose, and (2) is paired
// with an end-to-end integration test
// (language-rule-profiles.integration.test.ts) proving a payload that is
// valid against every field's own maxItems can still be rejected 422 for
// exceeding the combined total.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { MAX_LITERAL_TERM_LENGTH, MAX_LITERAL_TERMS } from '../ast/language-rule-schemas.js';
import { loadRawSpec } from '../test-utils/contract/validate-response.js';

const LanguageRulesArrayFieldSchema = z.object({
  type: z.literal('array'),
  maxItems: z.number(),
  description: z.string(),
});

// The unbounded read/response fields still declared shape (type) but must
// carry NO length/count bound — maxLength/maxItems are captured as optional
// so their absence can be asserted without stripping them silently.
const UnboundedTermFieldSchema = z.object({
  type: z.literal('string'),
  maxLength: z.number().optional(),
});
const UnboundedArrayFieldSchema = z.object({
  type: z.literal('array'),
  maxItems: z.number().optional(),
});

const WriteAllOfSchema = <T extends z.ZodType>(overrideProperties: T) =>
  z.object({
    allOf: z.tuple([
      z.unknown(),
      z.object({ type: z.literal('object'), properties: overrideProperties }),
    ]),
  });

const RawSpecSchema = z.object({
  components: z.object({
    schemas: z.object({
      LanguageRuleTerm: z.object({
        properties: z.object({ term: UnboundedTermFieldSchema }),
      }),
      LanguageRules: z.object({
        properties: z.object({
          bannedTerms: UnboundedArrayFieldSchema,
          reinforcingWords: UnboundedArrayFieldSchema,
          partyVocabulary: UnboundedArrayFieldSchema,
          requiredPhrases: UnboundedArrayFieldSchema,
        }),
      }),
      LanguageRuleTermWrite: WriteAllOfSchema(
        z.object({ term: z.object({ maxLength: z.number() }) })
      ),
      LanguageRulesWrite: WriteAllOfSchema(
        z.object({
          bannedTerms: LanguageRulesArrayFieldSchema,
          reinforcingWords: LanguageRulesArrayFieldSchema,
          partyVocabulary: LanguageRulesArrayFieldSchema,
          requiredPhrases: LanguageRulesArrayFieldSchema,
        })
      ),
    }),
  }),
});

describe('openapi.yaml — language-rule literal-term bounds mirror the Zod write schema (#541)', () => {
  it('LanguageRuleTerm (shared read/response schema) declares no maxLength — GET must not re-bound grandfathered rows', async () => {
    const raw = RawSpecSchema.parse(await loadRawSpec());
    expect(
      raw.components.schemas.LanguageRuleTerm.properties.term.maxLength,
      'openapi.yaml LanguageRuleTerm.term must stay unbounded — LanguageRuleProfile.rules (used by ' +
        'GET responses) refs this schema, and a bound here would reject grandfathered pre-existing rows'
    ).toBeUndefined();
  });

  it.each(['bannedTerms', 'reinforcingWords', 'partyVocabulary', 'requiredPhrases'] as const)(
    'LanguageRules.%s (shared read/response schema) declares no maxItems — GET must not re-bound grandfathered rows',
    async (field) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      expect(
        raw.components.schemas.LanguageRules.properties[field].maxItems,
        `openapi.yaml LanguageRules.${field} must stay unbounded — LanguageRuleProfile.rules (used ` +
          'by GET responses) refs this schema, and a bound here would reject a grandfathered profile'
      ).toBeUndefined();
    }
  );

  it('LanguageRuleTermWrite.term.maxLength equals MAX_LITERAL_TERM_LENGTH (drift guard)', async () => {
    const raw = RawSpecSchema.parse(await loadRawSpec());
    expect(
      raw.components.schemas.LanguageRuleTermWrite.allOf[1].properties.term.maxLength,
      'openapi.yaml LanguageRuleTermWrite.term.maxLength drifted from MAX_LITERAL_TERM_LENGTH — update openapi.yaml when the constant changes'
    ).toBe(MAX_LITERAL_TERM_LENGTH);
  });

  it.each(['bannedTerms', 'reinforcingWords', 'partyVocabulary', 'requiredPhrases'] as const)(
    'LanguageRulesWrite.%s.maxItems equals MAX_LITERAL_TERMS (drift guard)',
    async (field) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      expect(
        raw.components.schemas.LanguageRulesWrite.allOf[1].properties[field].maxItems,
        `openapi.yaml LanguageRulesWrite.${field}.maxItems drifted from MAX_LITERAL_TERMS — update openapi.yaml when the constant changes`
      ).toBe(MAX_LITERAL_TERMS);
    }
  );

  it.each(['bannedTerms', 'reinforcingWords', 'partyVocabulary', 'requiredPhrases'] as const)(
    "LanguageRulesWrite.%s's OWN description states the combined (not per-field) literal-term cap",
    async (field) => {
      const raw = RawSpecSchema.parse(await loadRawSpec());
      const description =
        raw.components.schemas.LanguageRulesWrite.allOf[1].properties[field].description;
      expect(
        description,
        `openapi.yaml LanguageRulesWrite.${field}.description must warn readers this field's ` +
          `maxItems is NOT independent — it shares one combined ${MAX_LITERAL_TERMS}-term cap ` +
          'with the other 3 literal-term categories (a reader viewing only this field would ' +
          'otherwise assume its maxItems applies on its own)'
      ).toMatch(/combined/i);
      expect(
        description,
        `openapi.yaml LanguageRulesWrite.${field}.description must name the number`
      ).toContain(String(MAX_LITERAL_TERMS));
    }
  );
});
