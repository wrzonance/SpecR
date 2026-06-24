// Comment-closure heuristics (#256 C1 / #262). A Word review comment is treated
// as "closed" when EITHER closure signal the user named is present:
//   1. strike-out on the comment runs (captured as DocxComment.struck), or
//   2. the word "Closed" at the END of the comment text.
// Only a trailing "Closed" counts — see the KNOWN AMBIGUITY test for why a
// mid-sentence "Closed" is deliberately not treated as a closure marker.
//
// The text-suffix predicate lives in `ast` (textEndsWithClosed) so the
// SourceFactsSchema can apply the same rule when backfilling legacy facts that
// predate the stored `closed` flag. Re-exported here for parser-local callers.
import { textEndsWithClosed } from '../../ast/index.js';

export { textEndsWithClosed };

export interface ClosureSignals {
  readonly text: string;
  readonly struck: boolean;
}

export function isCommentClosed({ text, struck }: ClosureSignals): boolean {
  return struck || textEndsWithClosed(text);
}
