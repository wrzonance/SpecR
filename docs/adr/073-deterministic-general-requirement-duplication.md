# ADR-073: Deterministic General-Requirement Duplication Boundary

## Status

Accepted.

## Context

Division 00/01 documents and a division's `DD 00 00` umbrella are the natural
owners of requirements that apply across technical sections. Repeating those
requirements in each technical section creates drift: the same requirement can
be revised in one place and remain stale elsewhere. ADR-023 keeps the division
general relationship separate from custody, ADR-033 supplies deterministic
article roles, and ADR-042 checks whether subordinate sections cite their
umbrella, but none of them reports repeated article subjects.

Content equivalence is not deterministic at this boundary. Two articles can use
different words for the same requirement, while two identically titled QUALITY
ASSURANCE articles can contain legitimately different general and
system-specific requirements. Semantic or LLM comparison would add opaque
thresholds and non-repeatable findings. Conversely, treating every common PART 1
heading as proven duplicate content would overstate what the available evidence
shows.

The canonical AST strips rendered numbering from many headings. In persistence,
PART 1 is therefore identified as the first visible root `part`, ordered by its
sibling position, not by requiring its text to contain the literal `PART 1`
prefix. Root notes and other non-part nodes do not change the part number.

## Decision

Add an advisory `general_requirement_duplicated` coordination finding using a
strict article-level boundary:

1. The source is a visible PART 1 article in a present **technical section**: a
   parseable section outside Divisions 00/01 that is not itself `DD 00 00`.
2. Authorities are visible PART 1 articles from present Division 00/01 specs and
   the source section's own present `DD 00 00` umbrella. An umbrella from another
   division is never compared.
3. Two articles overlap when they have the same derived `articleRole` (ADR-033),
   or, if the role boundary does not match, the same exact normalized title.
   Title normalization reuses ADR-033's boundary: trim, strip an optional CSI
   article-number prefix, collapse whitespace, and uppercase. No token,
   substring, fuzzy, embedding, or semantic similarity is used.
4. `references` and `related-sections` are pointer-only roles and are excluded.
   Their purpose is to point to external authorities, so matching headings are
   not evidence of restated requirements.
5. Each source-authority pair produces one finding carrying both paragraph UUID
   locators, both section numbers and titles, the authority kind, and the match
   basis/value. Repeated query rows are deduplicated by the locator pair, and
   findings are sorted by source then authority identity for stable responses.

This is deliberately a **review clue, not a content-equivalence verdict**.
A system-specific addition under a broader common heading may be legitimate; the
two locators let the reviewer compare it directly. Authors can make a genuinely
narrow addition unambiguous with a narrower article heading. Automatically
removing or editing either article remains out of scope.

Authority availability is reported without conflating two different gaps:

- No present Division 00/01 spec adds a note that the Division 00/01 comparison
  was skipped.
- Each technical division whose `DD 00 00` is absent contributes its umbrella to
  a separate, sorted skipped-comparison note.

Available authorities are still checked. For example, a present umbrella is
checked even when Division 00/01 documents are absent. Package reports apply the
same rules to the package's present-spec island; project reports use project
membership. Findings remain computed on demand with no migration or persisted
state.

## Consequences

- Exact role/title restatement clues become visible and actionable without an
  LLM, with stable output and paragraph-level navigation on both sides.
- Punctuation variants of delivery/storage/handling headings compare
  consistently through ADR-033.
- Some common but legitimate headings can be flagged. The finding's advisory
  wording and paired locators are intentional safeguards; v1 does not claim the
  article bodies are equal.
- Differently titled semantic duplicates are false negatives by design. Closing
  that gap requires a later, separately governed semantic-content decision.
- Missing Division 00/01 and missing umbrella authorities remain visible rather
  than silently producing an empty result.

## Alternatives Considered

- **Compare article body text exactly.** Rejected. Formatting and harmless wording
  edits would hide real restatements, while exact boilerplate fragments do not
  establish that the whole article duplicates authority content.
- **Use fuzzy, embedding, or LLM similarity.** Rejected for v1. Thresholds,
  reproducibility, cost, and explainability require a separate ADR and product
  decision.
- **Flag every shared role including References and Related Sections.** Rejected.
  Those roles are intentionally pointers and would create high-volume false
  positives.
- **Suppress common-role findings unless article bodies also match.** Rejected.
  That changes the requested deterministic role/title check into an incomplete
  content-comparison algorithm and obscures why a result did or did not fire.
- **Skip the entire check when either authority class is absent.** Rejected.
  Available authorities can still expose a useful overlap; separate notes state
  exactly which comparison could not run.

## Related

ADR-023 (division-general inheritance), ADR-029 and ADR-043 (coordination report
and note semantics), ADR-033 (derived article roles and title normalization),
ADR-042 (all-division umbrella checks), issue #410.
