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

// #541 — write-boundary bounds on literal (isRegex !== true) terms, mirroring
// the ReDoS/length/count guard `checkRegexPatterns` already applies to
// isRegex:true terms (src/lib/regex-safety.ts, MAX_REGEX_PATTERN_LENGTH=200 /
// MAX_REGEX_PATTERNS=64). Literal text carries no ReDoS risk — it is always
// escaped before use (src/db/queries/language-rule-findings.ts), never
// interpreted as regex syntax — so this bound exists purely to keep a
// profile's total term count (and the resulting per-scan matcher-compilation
// cost) from growing unbounded, not for safety. 500 (not 200, the regex
// SOURCE cap) because a literal term is a natural-language phrase, not a
// short regex source — matching this codebase's existing prose-length
// convention (e.g. openapi.yaml title fields cap at 500). 500 whole-profile
// terms (not 64, the regex-term cap) because ADR-080 frames literal terms as
// the majority of a real firm's list.
export const MAX_LITERAL_TERM_LENGTH = 500;
export const MAX_LITERAL_TERMS = 500;

function isLiteralTerm(term: LanguageRuleTerm): boolean {
  return term.isRegex !== true;
}

// Every literal term's text across all 4 categories, flattened for one bounds
// check — mirrors allRegexTerms' whole-profile scope
// (src/db/queries/language-rule-profiles.ts) but over the disjoint
// isRegex !== true subset.
function literalTermTextsIn(rules: LanguageRules): readonly string[] {
  const categories: ReadonlyArray<readonly LanguageRuleTerm[] | undefined> = [
    rules.bannedTerms,
    rules.reinforcingWords,
    rules.partyVocabulary,
    rules.requiredPhrases,
  ];
  return categories.flatMap((terms) =>
    (terms ?? []).filter(isLiteralTerm).map((term) => term.term)
  );
}

// Write-path schema: the structural schema (LanguageRulesSchema, still used
// unbounded by mapRow's read path) PLUS the literal-term size invariant.
// Follows the HeaderFooterCompositionWriteSchema precedent (ADR-070,
// header-footer-schemas.ts) verbatim — a write-only sibling `.check()` layered
// on an otherwise-identical base schema, so existing rows whose literal terms
// already exceed this bound keep reading successfully (grandfathered) while
// only new writes are held to it.
export const LanguageRulesWriteSchema = LanguageRulesSchema.check((ctx) => {
  const literalTerms = literalTermTextsIn(ctx.value);
  if (literalTerms.some((term) => term.length > MAX_LITERAL_TERM_LENGTH)) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: `a literal term exceeds ${MAX_LITERAL_TERM_LENGTH} characters`,
    });
  }
  if (literalTerms.length > MAX_LITERAL_TERMS) {
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message:
        'too many literal terms across bannedTerms/reinforcingWords/' +
        `partyVocabulary/requiredPhrases (max ${MAX_LITERAL_TERMS})`,
    });
  }
});
