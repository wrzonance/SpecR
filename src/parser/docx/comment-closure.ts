// Comment-closure heuristics (#256 C1 / #262). A Word review comment is treated
// as "closed" when EITHER closure signal the user named is present:
//   1. strike-out on the comment runs (captured as DocxComment.struck), or
//   2. the word "Closed" at the END of the comment text.
// Only a trailing "Closed" counts — see the KNOWN AMBIGUITY test for why a
// mid-sentence "Closed" is deliberately not treated as a closure marker.

// Matches a final "Closed" token, case-insensitively, tolerating trailing
// whitespace and a single trailing period (e.g. "… Closed", "… closed.").
// `\bclosed` requires a word boundary so "enclosed" does not match.
const CLOSED_SUFFIX = /\bclosed\.?\s*$/i;

export function textEndsWithClosed(text: string): boolean {
  return CLOSED_SUFFIX.test(text);
}

export interface ClosureSignals {
  readonly text: string;
  readonly struck: boolean;
}

export function isCommentClosed({ text, struck }: ClosureSignals): boolean {
  return struck || textEndsWithClosed(text);
}
