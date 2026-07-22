# ADR-076: Title-Block Deduplication and Heading Color

## Status

Accepted.

## Context

The generator always injects a canonical "SECTION `<number>` — `<title>`" heading
ahead of a tree's body (`titleParagraph`, `buildSectionChildren`). Some source
DOCX files also type that same identity out longhand as the document's own
opening lines — e.g. a centered `SECTION 01 8813.13` line followed by a centered
`CLEAN ZONE PRE-CERTIFICATION PROTOCOLS` line. Before this change, the 5-signal
engine had no reason to treat those two lines as anything but ordinary body
text: no signal recognized "this line just re-types the tree's own already-
resolved section/title," so they were classified as `continuation` SpecNodes
and rendered a second time. Round-tripping such a file therefore showed the
title block **three times** — the injected heading, then the same section
number, then the same title, in that order — even though the two source lines
carry no information the tree doesn't already have.

Separately, the injected heading used `docx`'s `HeadingLevel.HEADING_1` with no
explicit run color, so it inherited Word's default Heading1 **blue**. Every
other spec deliverable in this codebase renders black; the injected heading was
the one exception, and no existing style path controlled it — `styles.ts`
marks `color` out of scope for `runStyleOptions`, and `front-matter.ts`'s
`coverTitle()` is a distinct call site with its own template concerns.

Two directions could close the duplication half of the bug: suppress the
leading duplicate lines during parsing (nothing to render), or skip re-
injecting the canonical heading when the tree's own leading nodes already carry
it. A separate, `SpecNodeMeta`-based way to remember "this was a title
duplicate" was also available in principle, alongside extending
`runStyleOptions`/`styles.ts` to cover heading color generally.

## Decision

1. **Suppress on the parser side.** `buildTree` now consults a new,
   transient `leadingTitleBlockIndices(classified, section, title)` — computed
   once per call, never persisted, never attached to a node — and skips
   `appendContinuation` for any index it contains. The scan starts at index 0
   and:
   - adds an index when the continuation's text equals the document's own
     already-resolved section number (`isSectionIdentityLine`, tolerating the
     same formatting drift `parseSectionNumberCandidate('strong')` already
     tolerates elsewhere, after stripping a leading `SECTION` keyword) or its
     already-resolved title (`isTitleIdentityLine`, trim + whitespace-collapse
     + case-insensitive compare);
   - continues without consuming a slot on a blank or already-suppressed
     paragraph (interleaved blank lines don't break the run);
   - stops permanently at the first real structural (non-continuation) node,
     the first note-flagged continuation, or the first continuation whose text
     matches neither identity.
   - returns an empty set immediately when both `section` and `title` are
     `UNKNOWN_SECTION_IDENTITY` — there is nothing resolved to compare against.

   A duplicate line therefore produces **no SpecNode at all**, reusing the
   `#292` "suppressed → no SpecNode" precedent rather than introducing a new
   metadata field. `buildTree`'s exported signature and its call site are
   unchanged; the new predicates and scanner live in `heuristics.ts`, the
   existing home for S4 text predicates.

2. **Never suppress a genuine note.** `classifyLeadingCandidate` — the
   per-candidate decision the scan drives, see below — stops the scan on any
   `isNote: true` continuation *before* checking identity text. A real
   editorial note whose text happens to equal the section/title is content,
   not a round-trip artifact; matching it would have dropped it with no
   SpecNode at all, which is strictly worse than the leak this change fixes.

3. **Black title-block color, overridable by a style rule.** `titleParagraph`
   now emits an explicit `TextRun.color`, sourced from a small local helper:

   ```ts
   const DEFAULT_TITLE_COLOR = '000000';

   function titleParagraphColor(rules?: StyleRuleMap): string {
     return rules?.get('part')?.rPr?.color ?? DEFAULT_TITLE_COLOR;
   }
   ```

   A `part`-tier style rule's `rPr.color` overrides the default; otherwise the
   heading is explicit black, which wins over Word's Heading1 style-level
   blue. `StylePropertiesSchema` already carries `RunProperties.color`
   (`src/ast/style-schemas.ts`) — no schema change was needed.

### Complexity-driven extraction

`leadingTitleBlockIndices`'s scan loop, first written with the match/skip/stop
decision inlined, measured cognitive complexity 12 against the project's
enforced budget of 10 (`sonarjs/cognitive-complexity`). The per-candidate
decision was pulled out into a small, pure, independently-testable helper:

```ts
type LeadingScanStep = 'match' | 'skip' | 'stop';

function classifyLeadingCandidate(
  cp: ClassifiedParagraph,
  section: string,
  title: string
): LeadingScanStep;
```

The loop now just calls `classifyLeadingCandidate` per entry and switches on
its result. This is a mechanical split with no behavioral change — every
scenario (match, skip-blank, stop-at-structural, stop-at-note,
stop-at-non-matching-continuation, coincidental mid-document repeat left
untouched, `UNKNOWN_SECTION_IDENTITY` short-circuit) maps directly onto one of
the three `LeadingScanStep` values. `LeadingScanStep` is the one new struct
this change introduces; nothing else in `src/ast/types.ts` or any migration
changed.

## Alternatives Considered

- **Persist a "was a title duplicate" flag on `SpecNodeMeta`.** Rejected.
  Nothing is lost by producing no SpecNode: these lines resolve via the
  existing Signal-3 continuation fallback with no signal ever firing, so the
  "conflicts are persisted, never dropped" rule (`paragraphs.conflicts`) has
  nothing to violate — there was never a firing signal whose loser needed
  keeping. Reusing `meta.vanish` was also rejected: it carries real
  OOXML-hidden semantics consumed elsewhere, and overloading it here would
  make a "hidden in Word" query wrongly include "duplicate we chose not to
  render."
- **Skip re-injecting the canonical heading on the generator side instead.**
  Rejected as the primary direction. It would need the generator to inspect
  the tree's leading nodes and reconstruct the same identity comparison the
  parser already has cheaply available at classification time, and would
  leave the duplicate lines sitting in the tree as `continuation` nodes for
  every other consumer (Markdown render, MCP, coordination reports) to filter
  independently. Suppressing once, at the source of truth, is simpler and
  matches the "canonical AST is the source of truth" architecture rule.
- **Extend `runStyleOptions`/`styles.ts` to cover heading color generally.**
  Rejected. `styles.ts` explicitly marks color out of scope, and
  `runStyleOptions` is shared by every `numberedParagraph` call site plus
  `front-matter.ts`'s `coverTitle()`. Routing the fix through it would risk
  moving unrelated fixtures and violate the acceptance criterion that every
  fixture change from this PR be title-block-only. A two-line local helper
  scoped to `titleParagraph` alone satisfies the acceptance criterion without
  that blast radius.
- **Recognize a combined single-line variant** ("SECTION `<n>` — `<title>`" on
  one physical line). Left unhandled, deliberately. `isSectionIdentityLine`
  and `isTitleIdentityLine` each require the *whole* line to resolve to one
  identity (a section-number-only line, or a title-only line); a line that
  types both together matches neither and is retained as ordinary
  continuation content — the conservative, no-accidental-suppression default.
  This is **not** a `// KNOWN AMBIGUITY`: the correct behavior (recognize the
  combined pattern and suppress it too) is decidable, it is simply out of
  scope for this narrow fix, and is recorded here rather than diluting the
  `KNOWN AMBIGUITY` convention reserved for genuinely undecidable cases.

## Consequences

- A source authored with typed leading `SECTION`/title lines round-trips the
  title block exactly once; a source without them is unaffected (the scan's
  `UNKNOWN_SECTION_IDENTITY` short-circuit and its "stop at first
  non-matching/non-continuation node" rule mean nothing fires unless both an
  already-resolved identity and a literal repeat of it are present).
- The injected canonical heading is explicit black by default and can be
  overridden by a firm's own `part`-tier style rule, matching every other
  black spec deliverable.
- A genuine editorial note is never silently dropped merely because its text
  coincidentally equals the section/title.
- The combined single-line variant remains an open, explicitly out-of-scope
  gap for a future issue, not a defect in this one.
- Full-corpus revalidation (`pnpm fixture:snapshot`/`fixture:diff`,
  `pnpm gold:verify` against the 666-file `docs/references` corpus) showed
  **0/666 fixtures changed** and **0 FAILED** — none of the seed/proof-of-concept
  corpus files happen to contain the leading typed-duplicate pattern this fix
  targets; the only reproduction available is the gitignored, local-only
  manufacturer example (`parsing-needs-fixing.docx`), covered by a
  `describe.runIf`-gated integration test that skips automatically where the
  file is absent.

## Related

`#292` (suppressed → no SpecNode precedent), `#32` (color explicitly out of
scope for `runStyleOptions`), `#300`/ADR-072 (body-object rendering, a sibling
consumer of `buildSectionChildren`), issue #510.
