# ADR-058: Gold-corpus content-fidelity dimension

**Status:** Accepted

## Context

The WS3 gold gate (ADR-057, `gold:verify`) reduces each corpus file to a coarse,
structural `GoldFingerprint` — `section, parts, noteLeaks, maxDepth, partShape,
confidenceBands`. It vetoes a real paragraph disappearing or being reclassified
as a note (counts change), but it is blind to a real paragraph whose text is
silently truncated while the node survives at the same level: no count changes,
the fingerprint stays green, content is lost. As the engine is iterated against a
more diverse/malformed corpus, the gate must also fail on lost words.

Constraints on any content measure: it must not red-herring when the parser
learns to strip junk better; it must survive benign edits (a typo fix must not
fail the gate); and it must remain a commit-safe fact (Feist), since the `.docx`
corpus stays gitignored.

## Decision

Add `contentChars: readonly number[]` to `GoldFingerprint` — a whitespace-
normalized character count aggregated per visible part.

- **Real content only.** Counts structural nodes (`part`/`article`/`pr1…pr7`) and
  `continuation` body text. Excludes `note` (specifier instructions), any
  `vanish` subtree, the `spec` root, and content outside any part (front matter —
  naturally excluded by the per-part aggregation). A whole-document count is
  rejected: it would trip the moment junk is stripped better.
- **Character count, whitespace-normalized** (`\s+` → single space, trimmed). Not a
  content hash — a hash trips on a single benign character change; the baseline
  must survive benign edits. Characters over words: more sensitive to partial-word
  truncation.
- **Per visible part**, parallel to `partShape`, so a diff localizes which part
  lost text and the measure is robust to intra-part reordering.

## Consequences

- `gold:verify` now trips on silent intra-paragraph text loss (a `contentChars`
  delta) while structure is unchanged — the failure the structural fingerprint
  could not see.
- **Re-bless on real-content change (accepted).** Because notes/junk are excluded,
  a correct future improvement that reclassifies currently-real-looking junk into
  a note (or strips it) lowers a part's `contentChars` and trips the gate — forcing
  a re-bless. This is the gold contract working (any change to blessed truth, better
  or worse, a human confirms once), and strictly better than a whole-document count
  that would trip on every junk-handling change.
- Tables (#300) and a "important tables vs. junk tables" model are deferred; when
  built they plug into the same real-content predicate.
- The committed store `gold/expectations.json` is `{}` (zero blessed entries), so
  the additive-required schema field needs no migration or re-bless of existing
  data.
- Extends ADR-057; the runner stays local-only, never wired into cloud CI.
