// Pure text-suffix closure predicate (#262). A review comment is treated as
// "closed" when its text ends in the word "Closed". This is the only closure
// signal recoverable from persisted source facts — the strike-out signal is a
// parse-time-only property of the comment runs and is not stored.
//
// Lives in `ast` (the lowest layer) so both the parser (parse-time derivation,
// alongside the strike-out signal) and the SourceFactsSchema (read-time
// backfill for facts persisted before the `closed` field existed) share one
// definition of what a "Closed" suffix means.

// Matches a final "Closed" token, case-insensitively, tolerating trailing
// whitespace and a single trailing period (e.g. "… Closed", "… closed.").
// `\bclosed` requires a word boundary so "enclosed" does not match.
const CLOSED_SUFFIX = /\bclosed\.?\s*$/i;

export function textEndsWithClosed(text: string): boolean {
  return CLOSED_SUFFIX.test(text);
}
