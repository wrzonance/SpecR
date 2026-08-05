import { scanChoiceTokens } from '../../parser/index.js';
import type { SourceFacts } from '../../ast/index.js';

// #545 — re-derives ONLY the `choiceTokens` portion of a paragraph's
// `source_facts` from its NEW text on a text edit (updateParagraphText,
// paragraphs.ts). Every other key survives byte-identical: `comments` in
// particular is an OOXML-only artifact (comment authorship/closure) that
// does not survive into plain text and must NEVER be re-derived here — doing
// so would silently fabricate or drop comment-closure state a text edit
// cannot possibly know about. `colors`, `highlights`, `emphasis`, `banner`,
// `vanish`, and any future/unknown key (SourceFacts' index signature) are
// likewise parse-time-only facts, copied through untouched.
//
// Reuses the parser's own choice-token detector (src/parser/docx/choice-
// tokens.ts, exported through the parser barrel) rather than re-implementing
// detection here — the same syntax (adjacent bracket/angle groups) must stay
// in exact lockstep with what DOCX import itself would have found, or an
// edit could silently disagree with a fresh re-import of the same text.
export function deriveNextSourceFacts(existing: SourceFacts, text: string): SourceFacts {
  const choiceTokens = scanChoiceTokens(text);
  // Matches the parser's own present-only-when-non-empty convention
  // (mirrors hasSourceFacts/toParagraphRow in paragraphs.ts) — an empty scan
  // OMITS the key entirely rather than storing `[]`, so a resolved
  // placeholder's finding clears by the key's absence, not an empty array
  // readiness-review.ts still has to special-case. Rebuild without the
  // single re-derived key (so a stale value is never left behind), mirroring
  // part-prefix.ts's own delete-then-reassemble pattern for the same reason.
  const rest: Record<string, unknown> = { ...existing };
  delete rest.choiceTokens;
  return {
    ...rest,
    ...(choiceTokens.length > 0 ? { choiceTokens } : {}),
  };
}
