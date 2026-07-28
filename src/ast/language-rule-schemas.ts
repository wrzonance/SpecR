import { z } from 'zod';

// #411 / ADR-080 — a firm's own language-lint vocabulary: banned terms,
// reinforcing words to avoid, recognized party names, and phrases a spec must
// contain somewhere. SpecR ships the schema and the matching engine, never
// rule content (ADR-080 D1): every category below starts empty until a firm
// authors it — there is no built-in default list.

export const LanguageRuleTermSchema = z
  .object({
    term: z.string().check(z.minLength(1)),
    isRegex: z.boolean().exactOptional(),
    suggestion: z.string().exactOptional(),
  })
  .strict();

// NOTE: every array field below ends `.readonly()` — a DELIBERATE deviation
// from ConventionRulesSchema (spec-tree-schemas.ts), which has no `.readonly()`
// on its array fields and doesn't need one. Zod v4's `z.array(...)` infers a
// mutable `T[]` member on `z.infer` by default; the merge/scan layer's pure
// helpers (ADR-080 D5/D7) return `readonly T[]` per this codebase's "never
// mutate inputs" rule, and assigning a `readonly T[]` result back into a
// mutable-typed `LanguageRules` field fails `tsc --noEmit` (TS4104) — this was
// reproduced 4x by the pre-implementation spike before the fix. Do not "clean
// this up" to match ConventionRulesSchema's style; the two schemas have
// different consumers and only this one needs the guarantee.
export const LanguageRulesSchema = z
  .object({
    bannedTerms: z.array(LanguageRuleTermSchema).readonly().exactOptional(),
    reinforcingWords: z.array(LanguageRuleTermSchema).readonly().exactOptional(),
    partyVocabulary: z.array(LanguageRuleTermSchema).readonly().exactOptional(),
    requiredPhrases: z.array(LanguageRuleTermSchema).readonly().exactOptional(),
  })
  .strict();

// PUT /libraries/{id}/language-rules and PUT /projects/{id}/language-rules
// body — a complete replacement of the scope's rule set. No `name` field
// (ADR-080 D10): a language-rule profile is a singleton per scope, unlike
// `editing_conventions`, so nothing needs naming.
export const PutLanguageRulesBodySchema = z
  .object({
    rules: LanguageRulesSchema,
  })
  .strict();

export type LanguageRuleTerm = z.infer<typeof LanguageRuleTermSchema>;
export type LanguageRules = z.infer<typeof LanguageRulesSchema>;
export type PutLanguageRulesBody = z.infer<typeof PutLanguageRulesBodySchema>;
